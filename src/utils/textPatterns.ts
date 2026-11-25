/** rejects control and invisible formatting characters (e.g. NUL, zero width space, right-to-left override) */
export const NO_CONTROL_CHARACTERS = /^[^\p{Cc}\p{Cf}]*$/u;
