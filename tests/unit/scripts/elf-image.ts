/**
 * A tiny Linux program header (ELF) built in memory, for the tests of the
 * static Linux helper the Windows package carries (scripts/verify-bundled-
 * helper.mjs, scripts/write-helper-manifest.mjs). It is never written to disk
 * or run: only the parts the static check reads are real (the ELF header, the
 * program headers, and the dynamic section's entries).
 */

export type ElfSpec = {
  /** EI_CLASS: 2 for 64-bit (the default), 1 for 32-bit. */
  cls?: number
  /** e_machine: 62 for x86-64 (the default), 183 for AArch64. */
  machine?: number
  /** A PT_INTERP header: a program that needs a loader (glibc's). */
  interp?: boolean
  /** A PT_DYNAMIC header (a static-pie musl program has one, with no NEEDED entry). */
  dynamic?: boolean
  /** A DT_NEEDED entry in the dynamic section: a program that needs a shared library. */
  needed?: boolean
  /** Bytes after the headers, so two programs can differ in their content. */
  body?: number[]
}

const PT_LOAD = 1
const PT_DYNAMIC = 2
const PT_INTERP = 3
const PHENT = 56

export function buildElf({ cls = 2, machine = 62, interp = false, dynamic = true, needed = false, body = [] }: ElfSpec = {}): Buffer {
  const types = [PT_LOAD, ...(interp ? [PT_INTERP] : []), ...(dynamic ? [PT_DYNAMIC] : [])]
  const phoff = 64
  const dynAt = phoff + types.length * PHENT
  // DT_NEEDED (1), DT_FLAGS_1 (0x6ffffffb: PIE), DT_NULL (0): 16 bytes each.
  const entries: Array<[bigint, bigint]> = [...(needed ? [[1n, 1n] as [bigint, bigint]] : []), [0x6ffffffbn, 0x08000000n], [0n, 0n]]
  const dynSize = entries.length * 16
  const b = Buffer.alloc(dynAt + dynSize + body.length)
  b.set([0x7f, 0x45, 0x4c, 0x46, cls, 1, 1], 0)
  b.writeUInt16LE(3, 16) // e_type: ET_DYN, as a static-pie program is
  b.writeUInt16LE(machine, 18)
  b.writeUInt32LE(1, 20)
  b.writeBigUInt64LE(BigInt(phoff), 32)
  b.writeUInt16LE(64, 52)
  b.writeUInt16LE(PHENT, 54)
  b.writeUInt16LE(types.length, 56)
  types.forEach((type, i) => {
    const at = phoff + i * PHENT
    b.writeUInt32LE(type, at)
    if (type === PT_DYNAMIC) {
      b.writeBigUInt64LE(BigInt(dynAt), at + 8)
      b.writeBigUInt64LE(BigInt(dynSize), at + 32)
    }
  })
  entries.forEach(([tag, val], i) => {
    b.writeBigInt64LE(tag, dynAt + i * 16)
    b.writeBigUInt64LE(val, dynAt + i * 16 + 8)
  })
  b.set(body, dynAt + dynSize)
  return b
}
