//! A small JSON reader and writer, so the helper needs no JSON crate (the
//! supply-chain budget is under 25 crates and no proc macros, threat model 3.10).
//!
//! It reads RFC 8259 JSON from UTF-8 bytes with the protocol's depth limit
//! (section 6: JSON depth 32) and writes compact JSON with object keys in the
//! order they were given, so a message encodes the same bytes on every OS.

/// Nesting limit of a JSON control message: arrays and objects together.
pub const MAX_DEPTH: usize = 32;

#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    /// The number exactly as written; the schema layer decides what it means.
    Num(String),
    Str(String),
    Arr(Vec<Value>),
    /// Members in source order. A repeated key keeps both; `get` finds the first.
    Obj(Vec<(String, Value)>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JsonError {
    /// Not JSON; the number is the byte offset where reading stopped.
    Syntax(usize),
    /// More than `MAX_DEPTH` levels of arrays and objects.
    TooDeep,
    /// The bytes are not valid UTF-8.
    Utf8,
    /// Something follows the value.
    Trailing,
}

impl Value {
    pub fn obj(members: Vec<(&str, Value)>) -> Value {
        Value::Obj(members.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
    }

    pub fn str(s: &str) -> Value {
        Value::Str(s.to_string())
    }

    pub fn uint(n: u64) -> Value {
        Value::Num(n.to_string())
    }

    pub fn strs(items: &[&str]) -> Value {
        Value::Arr(items.iter().map(|s| Value::str(s)).collect())
    }

    pub fn get(&self, key: &str) -> Option<&Value> {
        match self {
            Value::Obj(members) => members.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::Str(s) => Some(s.as_str()),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Value::Bool(b) => Some(*b),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&Vec<Value>> {
        match self {
            Value::Arr(items) => Some(items),
            _ => None,
        }
    }

    /// A non-negative integer written with digits only (no sign, point or exponent).
    pub fn as_u64(&self) -> Option<u64> {
        match self {
            Value::Num(n) if !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()) => n.parse::<u64>().ok(),
            _ => None,
        }
    }

    /// True when arrays and objects nest at most `limit` levels deep. It stops
    /// at the limit, so a hostile or runaway value costs no deep recursion.
    pub fn fits_depth(&self, limit: usize) -> bool {
        match self {
            Value::Arr(items) => limit > 0 && items.iter().all(|v| v.fits_depth(limit - 1)),
            Value::Obj(members) => limit > 0 && members.iter().all(|(_, v)| v.fits_depth(limit - 1)),
            _ => true,
        }
    }

    /// Compact JSON text.
    pub fn to_json(&self) -> String {
        let mut out = String::new();
        self.write_to(&mut out);
        out
    }

    fn write_to(&self, out: &mut String) {
        match self {
            Value::Null => out.push_str("null"),
            Value::Bool(true) => out.push_str("true"),
            Value::Bool(false) => out.push_str("false"),
            Value::Num(n) => out.push_str(n),
            Value::Str(s) => write_string(s, out),
            Value::Arr(items) => {
                out.push('[');
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    item.write_to(out);
                }
                out.push(']');
            }
            Value::Obj(members) => {
                out.push('{');
                for (i, (k, v)) in members.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    write_string(k, out);
                    out.push(':');
                    v.write_to(out);
                }
                out.push('}');
            }
        }
    }
}

fn write_string(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// Read one JSON value from `input`; anything after it is an error.
pub fn parse(input: &[u8]) -> Result<Value, JsonError> {
    let text = std::str::from_utf8(input).map_err(|_| JsonError::Utf8)?;
    let mut p = Parser { s: text.as_bytes(), text, pos: 0 };
    p.skip_ws();
    let value = p.value(0)?;
    p.skip_ws();
    if p.pos != p.s.len() {
        return Err(JsonError::Trailing);
    }
    Ok(value)
}

struct Parser<'a> {
    s: &'a [u8],
    text: &'a str,
    pos: usize,
}

impl<'a> Parser<'a> {
    fn err<T>(&self) -> Result<T, JsonError> {
        Err(JsonError::Syntax(self.pos))
    }

    fn skip_ws(&mut self) {
        while self.pos < self.s.len() && matches!(self.s[self.pos], b' ' | b'\t' | b'\n' | b'\r') {
            self.pos += 1;
        }
    }

    fn peek(&self) -> Option<u8> {
        self.s.get(self.pos).copied()
    }

    fn eat(&mut self, byte: u8) -> bool {
        if self.peek() == Some(byte) {
            self.pos += 1;
            true
        } else {
            false
        }
    }

    fn literal(&mut self, word: &str, value: Value) -> Result<Value, JsonError> {
        if self.s[self.pos..].starts_with(word.as_bytes()) {
            self.pos += word.len();
            Ok(value)
        } else {
            self.err()
        }
    }

    /// `depth` is how many arrays and objects enclose this value.
    fn value(&mut self, depth: usize) -> Result<Value, JsonError> {
        match self.peek() {
            Some(b'{') => self.object(depth + 1),
            Some(b'[') => self.array(depth + 1),
            Some(b'"') => Ok(Value::Str(self.string()?)),
            Some(b't') => self.literal("true", Value::Bool(true)),
            Some(b'f') => self.literal("false", Value::Bool(false)),
            Some(b'n') => self.literal("null", Value::Null),
            Some(b'-') | Some(b'0'..=b'9') => self.number(),
            _ => self.err(),
        }
    }

    fn array(&mut self, depth: usize) -> Result<Value, JsonError> {
        if depth > MAX_DEPTH {
            return Err(JsonError::TooDeep);
        }
        self.pos += 1; // [
        let mut items = Vec::new();
        self.skip_ws();
        if self.eat(b']') {
            return Ok(Value::Arr(items));
        }
        loop {
            self.skip_ws();
            items.push(self.value(depth)?);
            self.skip_ws();
            if self.eat(b',') {
                continue;
            }
            if self.eat(b']') {
                return Ok(Value::Arr(items));
            }
            return self.err();
        }
    }

    fn object(&mut self, depth: usize) -> Result<Value, JsonError> {
        if depth > MAX_DEPTH {
            return Err(JsonError::TooDeep);
        }
        self.pos += 1; // {
        let mut members = Vec::new();
        self.skip_ws();
        if self.eat(b'}') {
            return Ok(Value::Obj(members));
        }
        loop {
            self.skip_ws();
            if self.peek() != Some(b'"') {
                return self.err();
            }
            let key = self.string()?;
            self.skip_ws();
            if !self.eat(b':') {
                return self.err();
            }
            self.skip_ws();
            let value = self.value(depth)?;
            members.push((key, value));
            self.skip_ws();
            if self.eat(b',') {
                continue;
            }
            if self.eat(b'}') {
                return Ok(Value::Obj(members));
            }
            return self.err();
        }
    }

    fn number(&mut self) -> Result<Value, JsonError> {
        let start = self.pos;
        self.eat(b'-');
        match self.peek() {
            Some(b'0') => self.pos += 1,
            Some(b'1'..=b'9') => self.digits(),
            _ => return self.err(),
        }
        if self.peek() == Some(b'.') {
            self.pos += 1;
            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return self.err();
            }
            self.digits();
        }
        if matches!(self.peek(), Some(b'e') | Some(b'E')) {
            self.pos += 1;
            if matches!(self.peek(), Some(b'+') | Some(b'-')) {
                self.pos += 1;
            }
            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return self.err();
            }
            self.digits();
        }
        Ok(Value::Num(self.text[start..self.pos].to_string()))
    }

    fn digits(&mut self) {
        while matches!(self.peek(), Some(b'0'..=b'9')) {
            self.pos += 1;
        }
    }

    fn hex4(&mut self) -> Result<u32, JsonError> {
        if self.pos + 4 > self.s.len() {
            return self.err();
        }
        let mut n: u32 = 0;
        for i in 0..4 {
            let d = match (self.s[self.pos + i] as char).to_digit(16) {
                Some(d) => d,
                None => return self.err(),
            };
            n = n * 16 + d;
        }
        self.pos += 4;
        Ok(n)
    }

    fn string(&mut self) -> Result<String, JsonError> {
        self.pos += 1; // opening quote
        let mut out = String::new();
        loop {
            // Copy a run of plain bytes in one go; `text` is valid UTF-8 and the
            // run ends at an ASCII byte, so the slice is on a character boundary.
            let run_start = self.pos;
            while self.pos < self.s.len() {
                let b = self.s[self.pos];
                if b == b'"' || b == b'\\' || b < 0x20 {
                    break;
                }
                self.pos += 1;
            }
            out.push_str(&self.text[run_start..self.pos]);
            match self.peek() {
                None => return self.err(),
                Some(b'"') => {
                    self.pos += 1;
                    return Ok(out);
                }
                Some(b'\\') => {
                    self.pos += 1;
                    let esc = match self.peek() {
                        Some(e) => e,
                        None => return self.err(),
                    };
                    self.pos += 1;
                    match esc {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{08}'),
                        b'f' => out.push('\u{0c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let first = self.hex4()?;
                            let code = if (0xD800..0xDC00).contains(&first) {
                                // A high surrogate must be followed by \uDC00..\uDFFF.
                                if !(self.eat(b'\\') && self.eat(b'u')) {
                                    return self.err();
                                }
                                let second = self.hex4()?;
                                if !(0xDC00..0xE000).contains(&second) {
                                    return self.err();
                                }
                                0x10000 + ((first - 0xD800) << 10) + (second - 0xDC00)
                            } else if (0xDC00..0xE000).contains(&first) {
                                return self.err();
                            } else {
                                first
                            };
                            match char::from_u32(code) {
                                Some(c) => out.push(c),
                                None => return self.err(),
                            }
                        }
                        _ => return self.err(),
                    }
                }
                // A raw control character inside a string.
                Some(_) => return self.err(),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_and_writes_the_same_compact_text() {
        let text = r#"{"t":"ping","id":2,"x":[1,-2.5e3,true,false,null,"a\"b"],"o":{}}"#;
        let v = parse(text.as_bytes()).unwrap();
        assert_eq!(v.to_json(), text);
        assert_eq!(v.get("t").and_then(Value::as_str), Some("ping"));
        assert_eq!(v.get("id").and_then(Value::as_u64), Some(2));
    }

    #[test]
    fn decodes_escapes_and_surrogate_pairs() {
        let v = parse(br#""a\n\u00e9\ud83d\ude00""#).unwrap();
        assert_eq!(v.as_str(), Some("a\n\u{e9}\u{1f600}"));
        assert!(parse(br#""\ud83d""#).is_err());
        assert!(parse(br#""\ude00""#).is_err());
    }

    #[test]
    fn refuses_what_is_not_json() {
        for bad in ["", "{", "{\"a\"}", "[1,]", "01", "1.", "+1", "\"\u{1}\"", "nul", "{\"a\":1,}", "[1] x"] {
            assert!(parse(bad.as_bytes()).is_err(), "{bad:?}");
        }
        assert_eq!(parse(&[0x22, 0xff, 0x22]), Err(JsonError::Utf8));
        assert_eq!(parse(b"1 2"), Err(JsonError::Trailing));
    }

    #[test]
    fn depth_32_reads_and_depth_33_does_not() {
        let nest = |n: usize| format!("{}{}", "[".repeat(n), "]".repeat(n));
        assert!(parse(nest(32).as_bytes()).is_ok());
        assert_eq!(parse(nest(33).as_bytes()), Err(JsonError::TooDeep));
        let objs = |n: usize| format!("{}1{}", "{\"a\":".repeat(n), "}".repeat(n));
        assert!(parse(objs(32).as_bytes()).is_ok());
        assert_eq!(parse(objs(33).as_bytes()), Err(JsonError::TooDeep));
    }

    #[test]
    fn fits_depth_agrees_with_the_reader() {
        let nest = |n: usize| (0..n).fold(Value::Null, |inner, _| Value::Arr(vec![inner]));
        assert!(nest(0).fits_depth(MAX_DEPTH));
        assert!(nest(32).fits_depth(MAX_DEPTH));
        assert!(!nest(33).fits_depth(MAX_DEPTH));
        let objs = |n: usize| (0..n).fold(Value::Null, |inner, _| Value::Obj(vec![("a".to_string(), inner)]));
        assert!(objs(32).fits_depth(MAX_DEPTH));
        assert!(!objs(33).fits_depth(MAX_DEPTH));
    }

    #[test]
    fn writes_control_characters_as_escapes() {
        assert_eq!(Value::str("a\u{1}b\"\\\n").to_json(), "\"a\\u0001b\\\"\\\\\\n\"");
    }
}
