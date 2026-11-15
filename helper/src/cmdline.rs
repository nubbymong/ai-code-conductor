//! Windows command-line quoting, kept free of any Windows API so it is tested
//! on every OS. `CreateProcessW` takes one string; a program splits it back
//! with the rules of `CommandLineToArgvW`, so each word is quoted for them.

/// Append `arg` to `out` quoted so that it splits back as exactly one word.
pub fn quote_arg(arg: &str, out: &mut String) {
    let plain = !arg.is_empty() && !arg.chars().any(|c| matches!(c, ' ' | '\t' | '\n' | '\u{0b}' | '"'));
    if plain {
        out.push_str(arg);
        return;
    }
    out.push('"');
    let mut backslashes = 0usize;
    for c in arg.chars() {
        match c {
            '\\' => backslashes += 1,
            '"' => {
                // Backslashes before a quote are doubled, then the quote is escaped.
                for _ in 0..(backslashes * 2 + 1) {
                    out.push('\\');
                }
                out.push('"');
                backslashes = 0;
            }
            _ => {
                for _ in 0..backslashes {
                    out.push('\\');
                }
                backslashes = 0;
                out.push(c);
            }
        }
    }
    // Backslashes before the closing quote are doubled so they do not escape it.
    for _ in 0..(backslashes * 2) {
        out.push('\\');
    }
    out.push('"');
}

/// The whole command line for `argv`.
pub fn build_command_line(argv: &[String]) -> String {
    let mut out = String::new();
    for (i, arg) in argv.iter().enumerate() {
        if i > 0 {
            out.push(' ');
        }
        quote_arg(arg, &mut out);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn quoted(s: &str) -> String {
        let mut out = String::new();
        quote_arg(s, &mut out);
        out
    }

    #[test]
    fn plain_words_stay_as_they_are_and_empty_ones_are_quoted() {
        assert_eq!(quoted("abc"), "abc");
        assert_eq!(quoted(r"C:\tools\x.exe"), r"C:\tools\x.exe");
        assert_eq!(quoted(""), "\"\"");
    }

    #[test]
    fn spaces_and_quotes_are_quoted_and_backslashes_before_a_quote_are_doubled() {
        assert_eq!(quoted("a b"), "\"a b\"");
        assert_eq!(quoted("say \"hi\""), "\"say \\\"hi\\\"\"");
        assert_eq!(quoted(r"C:\a b\"), "\"C:\\a b\\\\\"");
        assert_eq!(quoted("a\\\"b"), "\"a\\\\\\\"b\"");
    }

    #[test]
    fn a_command_line_joins_the_words_with_single_spaces() {
        let argv = vec!["prog".to_string(), "two words".to_string(), "x".to_string()];
        assert_eq!(build_command_line(&argv), "prog \"two words\" x");
    }
}
