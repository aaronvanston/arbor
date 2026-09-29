// Arbor is written in US English: its interface text (tests/i18n.test.ts) and its public release notes
// (release-notes.mjs) are checked against these British spellings and their families.
const BRITISH = new RegExp(
  '\\b(?:' + [
    '\\w*(?:colour|behaviour|favour|honour|neighbour|labour|flavour|humour|rumour|savour|endeavour)\\w*',
    '\\w*(?:centre|centred|centres|centring)',
    '(?:metre|litre|fibre|theatre|licence|defence|offence|catalogue|programme|judgement|acknowledgement)s?',
    'whilst|amongst|learnt|spelt|gre(?:y|ys|yed|ying)',
    '\\w*(?:cancell|labell|modell|travell|signall|fuell|levell|totall|channell|tunnell)(?:ed|ing)',
    '\\w*(?:organis|recognis|prioritis|summaris|optimis|normalis|initialis|serialis|customis|authoris|minimis|maximis'
      + '|memois|utilis|visualis|categoris|sanitis|synchronis|realis|finalis|standardis|localis|specialis|stabilis'
      + '|apologis|capitalis|tokenis|penalis|criticis|generalis|personalis|randomis)(?:e|ed|es|ing|er|ers|ation|ations)',
    '(?:analys|paralys)(?:e|ed|ing)|emphasis(?:e|ed|es|ing)',
  ].join('|') + ')\\b',
  'gi',
);

/** The British spellings in `text`, each once, or [] when it's spelled the US way. */
export function britishSpellings(text) {
  return [...new Set(String(text).match(BRITISH) ?? [])];
}
