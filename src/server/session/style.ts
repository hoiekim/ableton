/**
 * The local rules' reading of the musician's style direction. Jev reads the
 * text itself; without Jev, common genre and mood words steer the choice.
 */

// Genre words and the patterns (any instrument) that suit them.
const GENRES: [RegExp, string[]][] = [
  [/funk|soul|disco|groov/, ["breakbeat", "syncopated", "funk-chops", "offbeat-stabs", "octave-bounce", "comping"]],
  [/house|techno|edm|dance|club|trance/, ["four-on-floor", "octave-bounce", "offbeat-stabs", "root-eighths", "arpeggio"]],
  [/rock|punk|metal|grunge|indie/, ["backbeat", "root-eighths", "power-eighths", "block-quarters", "strum-eighths"]],
  [/jazz|swing|bebop|blues/, ["shuffle", "walking", "comping", "half-notes"]],
  [/ballad|ambient|chill|calm|lo ?fi|dream/, ["sparse", "half-time", "pedal", "pad", "ballad-strum", "picking"]],
  [/hip ?hop|trap|boom ?bap|r ?& ?b|rnb/, ["breakbeat", "half-time", "syncopated", "pad", "half-notes"]],
  [/reggae|ska|dub/, ["offbeat-stabs", "half-time", "root-fifth"]],
  [/folk|country|acoustic|singer/, ["root-fifth", "strum-eighths", "strum-quarters", "picking", "backbeat"]],
  [/latin|afro|bossa|samba|salsa|cumbia/, ["percussion-groove", "syncopated", "comping", "picking"]],
  [/epic|cinematic|tribal|dramatic|anthem/, ["tom-groove", "build", "pad", "arpeggio", "power-eighths"]],
  [/pop/, ["backbeat", "root-quarters", "block-quarters", "strum-quarters"]],
];

const LOUDER = /intense|energetic|hard|heavy|aggressive|loud|driving|wild|big|climax/;
const QUIETER = /calm|soft|quiet|gentle|minimal|sparse|laid ?back|mellow|relaxed|sleepy/;

/** How much the direction favours a pattern: 1 when a genre word in it names the pattern. */
export const styleAffinity = (direction: string, patternId: string) => {
  const text = direction.toLowerCase();
  if (!text) return 0;
  return GENRES.some(([words, patterns]) => words.test(text) && patterns.includes(patternId)) ? 1 : 0;
};

/** How far the direction pushes energy: up for "intense", down for "laid back". */
export const energyBias = (direction: string) => {
  const text = direction.toLowerCase();
  return (LOUDER.test(text) ? 2 : 0) - (QUIETER.test(text) ? 2 : 0);
};
