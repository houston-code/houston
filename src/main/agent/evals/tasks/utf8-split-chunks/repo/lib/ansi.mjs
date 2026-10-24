// CSI sequences (colors, cursor moves) and OSC sequences such as hyperlinks
// (`ESC ] 8 ;; url ST label ESC ] 8 ;; ST`), which build tools love. An OSC ends with
// BEL or with ST (`ESC \\`).
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g

export function stripAnsi(text) {
  return text.replace(ANSI, '')
}
