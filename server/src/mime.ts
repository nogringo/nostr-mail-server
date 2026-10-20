import libmime from 'libmime'

const FIELD_START = /(?<=\n)(?![ \t])/

export interface SplitMessage {
  // Each field with its folded lines and line break.
  fields: string[]
  // The blank line and the body.
  rest: string
}

// Latin-1 keeps every byte, so joining the parts gives the message back.
export function splitHeader(message: Buffer): SplitMessage {
  const text = message.toString('latin1')
  // The leading newline lets a message without header fields end its header at 0.
  const blankLine = `\n${text}`.search(/\n\r?\n/)
  const headerEnd = blankLine === -1 ? text.length : blankLine
  return { fields: text.slice(0, headerEnd).split(FIELD_START), rest: text.slice(headerEnd) }
}

// The unfolded values of the fields with this name.
export function fieldValues(message: Buffer, name: string): string[] {
  const prefix = new RegExp(`^${name}[ \\t]*:`, 'i')
  return splitHeader(message)
    .fields.filter((field) => prefix.test(field))
    .map((field) =>
      field
        .slice(field.indexOf(':') + 1)
        .replace(/\r?\n(?=[ \t])/g, '')
        .trim(),
    )
}

// The first field with this name, raw UTF-8 (RFC 6532) and encoded words (RFC 2047) decoded.
export function decodedField(message: Buffer, name: string): string {
  const [value = ''] = fieldValues(message, name)
  return libmime.decodeWords(Buffer.from(value, 'latin1').toString('utf8'))
}
