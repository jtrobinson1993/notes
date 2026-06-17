/** Rendering for inline system notices (e.g. a member joining). The sender picks
 *  a phrase index at send time so everyone sees the same line; the display name
 *  is substituted live at render. Pure + tested. */

/** Join lines, `{name}` substituted at render. Index 0 is the plain one; the
 *  rest are picked at random for a bit of personality. */
export const JOIN_PHRASES = [
  '{name} joined the chat.',
  '{name} stumbled into the chat.',
  '{name} showed up out of the blue. Who invited this guy?',
  '{name} materialized out of thin air.',
  '{name} slid into the group chat.',
  'A wild {name} appeared!',
  '{name} crashed the party.',
  'Brace yourselves — {name} has entered the chat.',
] as const;

/** A random phrase index (what the sender embeds in the message). */
export function randomJoinPhrase(): number {
  return Math.floor(Math.random() * JOIN_PHRASES.length);
}

/** Resolve a join notice to its display string. Out-of-range indices fall back
 *  to the plain line, so an unknown future phrase never renders blank. */
export function joinText(name: string, phrase: number): string {
  const template = JOIN_PHRASES[phrase] ?? JOIN_PHRASES[0];
  return template.replace('{name}', name);
}
