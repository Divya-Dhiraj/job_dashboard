// location.js — Generic country-aware location filter.
// Replaces the original isGermanyLocation() with a configurable check that
// accepts a list of allowed ISO-2 country codes (e.g. ['de'], ['de','at','ch'],
// ['de','at','ch','nl','be','fr','es','it']). Each country has a small
// dictionary of positive terms (country name, top cities, states/regions) so
// scraped location strings — which come in many shapes — can be matched.
//
// The dictionaries are intentionally not exhaustive. Add cities here when you
// notice false negatives in your dashboard logs.

const COUNTRIES = {
  de: {
    name: 'Germany',
    aliases: ['germany', 'deutschland', 'german'],
    cities: [
      'berlin', 'munich', 'münchen', 'muenchen', 'hamburg', 'frankfurt',
      'cologne', 'köln', 'koeln', 'stuttgart', 'düsseldorf', 'dusseldorf',
      'dortmund', 'essen', 'leipzig', 'bremen', 'dresden', 'hannover', 'hanover',
      'nürnberg', 'nuremberg', 'duisburg', 'bochum', 'wuppertal', 'bielefeld',
      'bonn', 'münster', 'muenster', 'karlsruhe', 'mannheim', 'augsburg',
      'wiesbaden', 'gelsenkirchen', 'braunschweig', 'kiel', 'chemnitz', 'aachen',
      'freiburg', 'magdeburg', 'krefeld', 'halle', 'oberhausen', 'lübeck', 'luebeck',
      'erfurt', 'rostock', 'mainz', 'kassel', 'hagen', 'saarbrücken', 'saarbruecken',
      'potsdam', 'ludwigshafen', 'oldenburg', 'leverkusen', 'darmstadt', 'heidelberg',
      'regensburg', 'ingolstadt', 'würzburg', 'wuerzburg', 'ulm', 'wolfsburg',
      'paderborn', 'solingen', 'offenbach', 'göttingen', 'goettingen',
      'recklinghausen', 'reutlingen', 'koblenz', 'bremerhaven',
      'siegen', 'hildesheim', 'salzgitter', 'cottbus',
      'erlangen', 'jena', 'gera', 'mönchengladbach', 'monchengladbach',
      'fürth', 'fuerth', 'osnabrück', 'osnabrueck',
      'kaiserslautern', 'heilbronn', 'friedrichshafen',
      'bamberg', 'bayreuth', 'landshut', 'rosenheim',
      'aschaffenburg', 'hanau', 'fulda', 'marburg', 'gießen', 'giessen',
      'flensburg', 'neumünster', 'neumuenster',
    ],
    regions: [
      'bavaria', 'bayern', 'north rhine', 'nordrhein', 'westfalen', 'westphalia',
      'baden-württemberg', 'baden-wurttemberg', 'hessen', 'saxony', 'sachsen',
      'thuringia', 'thüringen', 'rhineland', 'rheinland',
      'lower saxony', 'niedersachsen', 'schleswig-holstein',
      'mecklenburg', 'vorpommern', 'brandenburg', 'saarland', 'sachsen-anhalt',
    ],
  },
  at: {
    name: 'Austria',
    aliases: ['austria', 'österreich', 'oesterreich', 'austrian'],
    cities: ['vienna', 'wien', 'graz', 'linz', 'salzburg', 'innsbruck', 'klagenfurt', 'villach', 'wels', 'sankt pölten'],
    regions: ['tyrol', 'tirol', 'styria', 'steiermark', 'carinthia', 'kärnten', 'vorarlberg', 'burgenland'],
  },
  ch: {
    name: 'Switzerland',
    aliases: ['switzerland', 'schweiz', 'suisse', 'svizzera', 'swiss'],
    cities: ['zurich', 'zürich', 'geneva', 'genève', 'basel', 'bern', 'lausanne', 'winterthur', 'lucerne', 'luzern', 'st. gallen', 'lugano', 'biel', 'thun'],
    regions: ['vaud', 'valais', 'ticino', 'aargau', 'graubünden'],
  },
  nl: {
    name: 'Netherlands',
    aliases: ['netherlands', 'nederland', 'holland', 'dutch'],
    cities: ['amsterdam', 'rotterdam', 'the hague', 'den haag', 'utrecht', 'eindhoven', 'tilburg', 'groningen', 'almere', 'breda', 'nijmegen', 'enschede', 'haarlem', 'arnhem', 'leiden', 'maastricht', 'delft'],
    regions: ['north holland', 'south holland', 'noord-holland', 'zuid-holland', 'flevoland', 'overijssel'],
  },
  be: {
    name: 'Belgium',
    aliases: ['belgium', 'belgië', 'belgique', 'belgian'],
    cities: ['brussels', 'bruxelles', 'antwerp', 'antwerpen', 'ghent', 'gent', 'charleroi', 'liège', 'bruges', 'brugge', 'namur', 'leuven', 'mons'],
    regions: ['flanders', 'vlaanderen', 'wallonia', 'wallonie'],
  },
  fr: {
    name: 'France',
    aliases: ['france', 'french', 'française', 'france,'],
    cities: ['paris', 'marseille', 'lyon', 'toulouse', 'nice', 'nantes', 'strasbourg', 'montpellier', 'bordeaux', 'lille', 'rennes', 'reims', 'le havre', 'saint-étienne', 'toulon', 'grenoble'],
    regions: ['île-de-france', 'ile-de-france', 'provence', 'normandy', 'normandie', 'brittany', 'bretagne'],
  },
  es: {
    name: 'Spain',
    aliases: ['spain', 'españa', 'espana', 'spanish'],
    cities: ['madrid', 'barcelona', 'valencia', 'seville', 'sevilla', 'zaragoza', 'málaga', 'malaga', 'murcia', 'palma', 'bilbao', 'alicante', 'córdoba', 'cordoba', 'valladolid', 'vigo', 'gijón'],
    regions: ['catalonia', 'catalunya', 'andalusia', 'andalucía', 'galicia', 'basque country', 'país vasco'],
  },
  it: {
    name: 'Italy',
    aliases: ['italy', 'italia', 'italian'],
    cities: ['rome', 'roma', 'milan', 'milano', 'naples', 'napoli', 'turin', 'torino', 'palermo', 'genoa', 'genova', 'bologna', 'florence', 'firenze', 'bari', 'catania', 'venice', 'venezia', 'verona', 'padua', 'padova'],
    regions: ['lombardy', 'lombardia', 'tuscany', 'toscana', 'lazio', 'sicily', 'sicilia', 'piedmont', 'piemonte'],
  },
  pt: {
    name: 'Portugal',
    aliases: ['portugal', 'portuguese'],
    cities: ['lisbon', 'lisboa', 'porto', 'amadora', 'braga', 'coimbra', 'funchal', 'almada', 'setúbal'],
    regions: ['algarve', 'azores', 'açores', 'madeira'],
  },
  ie: {
    name: 'Ireland',
    aliases: ['ireland', 'éire', 'irish', 'republic of ireland'],
    cities: ['dublin', 'cork', 'limerick', 'galway', 'waterford', 'drogheda', 'dundalk'],
    regions: ['leinster', 'munster', 'connacht', 'ulster'],
  },
  lu: {
    name: 'Luxembourg',
    aliases: ['luxembourg', 'luxemburg', 'lëtzebuerg'],
    cities: ['luxembourg city', 'esch-sur-alzette', 'differdange', 'dudelange'],
    regions: [],
  },
  dk: {
    name: 'Denmark',
    aliases: ['denmark', 'danmark', 'danish'],
    cities: ['copenhagen', 'københavn', 'aarhus', 'odense', 'aalborg', 'frederiksberg', 'esbjerg', 'randers'],
    regions: ['jutland', 'jylland', 'zealand', 'sjælland'],
  },
  se: {
    name: 'Sweden',
    aliases: ['sweden', 'sverige', 'swedish'],
    cities: ['stockholm', 'gothenburg', 'göteborg', 'malmö', 'malmo', 'uppsala', 'västerås', 'örebro', 'linköping', 'helsingborg', 'jönköping', 'norrköping', 'lund', 'umeå'],
    regions: ['skåne', 'scania', 'västra götaland', 'småland'],
  },
  no: {
    name: 'Norway',
    aliases: ['norway', 'norge', 'noreg', 'norwegian'],
    cities: ['oslo', 'bergen', 'stavanger', 'trondheim', 'drammen', 'fredrikstad', 'kristiansand', 'tromsø'],
    regions: [],
  },
  fi: {
    name: 'Finland',
    aliases: ['finland', 'suomi', 'finnish'],
    cities: ['helsinki', 'espoo', 'tampere', 'vantaa', 'oulu', 'turku', 'jyväskylä', 'lahti'],
    regions: ['uusimaa', 'lapland', 'lappi'],
  },
  is: {
    name: 'Iceland',
    aliases: ['iceland', 'ísland', 'icelandic'],
    cities: ['reykjavik', 'reykjavík', 'kópavogur', 'hafnarfjörður', 'akureyri'],
    regions: [],
  },
  pl: {
    name: 'Poland',
    aliases: ['poland', 'polska', 'polish'],
    cities: ['warsaw', 'warszawa', 'krakow', 'kraków', 'lodz', 'łódź', 'wroclaw', 'wrocław', 'poznan', 'poznań', 'gdansk', 'gdańsk', 'szczecin', 'bydgoszcz', 'lublin', 'katowice'],
    regions: ['silesia', 'mazovia', 'małopolska'],
  },
  cz: {
    name: 'Czechia',
    aliases: ['czechia', 'czech republic', 'česko', 'czech'],
    cities: ['prague', 'praha', 'brno', 'ostrava', 'plzen', 'plzeň', 'liberec', 'olomouc'],
    regions: ['bohemia', 'moravia'],
  },
  sk: {
    name: 'Slovakia',
    aliases: ['slovakia', 'slovensko', 'slovak'],
    cities: ['bratislava', 'košice', 'kosice', 'prešov', 'žilina', 'banská bystrica', 'nitra'],
    regions: [],
  },
  hu: {
    name: 'Hungary',
    aliases: ['hungary', 'magyarország', 'hungarian'],
    cities: ['budapest', 'debrecen', 'szeged', 'miskolc', 'pécs', 'győr', 'nyíregyháza'],
    regions: [],
  },
  ro: {
    name: 'Romania',
    aliases: ['romania', 'românia', 'romanian'],
    cities: ['bucharest', 'bucurești', 'cluj-napoca', 'cluj', 'timișoara', 'timisoara', 'iași', 'iasi', 'constanța', 'craiova', 'brașov'],
    regions: ['transylvania'],
  },
  bg: {
    name: 'Bulgaria',
    aliases: ['bulgaria', 'българия', 'bulgarian'],
    cities: ['sofia', 'plovdiv', 'varna', 'burgas', 'ruse', 'stara zagora'],
    regions: [],
  },
  gr: {
    name: 'Greece',
    aliases: ['greece', 'ελλάδα', 'greek', 'hellas'],
    cities: ['athens', 'αθήνα', 'thessaloniki', 'patras', 'heraklion', 'larissa'],
    regions: ['attica', 'crete', 'macedonia'],
  },
  hr: {
    name: 'Croatia',
    aliases: ['croatia', 'hrvatska', 'croatian'],
    cities: ['zagreb', 'split', 'rijeka', 'osijek', 'zadar'],
    regions: ['dalmatia'],
  },
  si: {
    name: 'Slovenia',
    aliases: ['slovenia', 'slovenija', 'slovenian'],
    cities: ['ljubljana', 'maribor', 'celje', 'kranj', 'koper'],
    regions: [],
  },
  ee: {
    name: 'Estonia',
    aliases: ['estonia', 'eesti', 'estonian'],
    cities: ['tallinn', 'tartu', 'narva', 'pärnu'],
    regions: [],
  },
  lt: {
    name: 'Lithuania',
    aliases: ['lithuania', 'lietuva', 'lithuanian'],
    cities: ['vilnius', 'kaunas', 'klaipėda', 'klaipeda', 'šiauliai'],
    regions: [],
  },
  lv: {
    name: 'Latvia',
    aliases: ['latvia', 'latvija', 'latvian'],
    cities: ['riga', 'rīga', 'daugavpils', 'liepāja', 'jelgava'],
    regions: [],
  },
  mt: {
    name: 'Malta',
    aliases: ['malta', 'maltese'],
    cities: ['valletta', 'birkirkara', 'mosta', 'sliema'],
    regions: [],
  },
  cy: {
    name: 'Cyprus',
    aliases: ['cyprus', 'κύπρος', 'cypriot'],
    cities: ['nicosia', 'limassol', 'larnaca', 'paphos'],
    regions: [],
  },
  gb: {
    name: 'United Kingdom',
    aliases: ['united kingdom', 'uk', 'great britain', 'britain', 'england', 'scotland', 'wales', 'northern ireland'],
    cities: ['london', 'manchester', 'birmingham', 'liverpool', 'leeds', 'glasgow', 'edinburgh', 'bristol', 'sheffield', 'cardiff', 'belfast', 'nottingham', 'newcastle', 'cambridge', 'oxford', 'reading'],
    regions: ['scotland', 'wales', 'england'],
  },
};

// Country-code presets for the UI
const PRESETS = {
  germany: { label: 'Germany only', codes: ['de'] },
  dach:    { label: 'DACH (DE/AT/CH)', codes: ['de', 'at', 'ch'] },
  benelux_dach: { label: 'DACH + Benelux', codes: ['de', 'at', 'ch', 'nl', 'be', 'lu'] },
  eu:      { label: 'European Union', codes: ['de', 'at', 'be', 'bg', 'hr', 'cy', 'cz', 'dk', 'ee', 'fi', 'fr', 'gr', 'hu', 'ie', 'it', 'lv', 'lt', 'lu', 'mt', 'nl', 'pl', 'pt', 'ro', 'sk', 'si', 'es', 'se'] },
  eea:     { label: 'EEA + Switzerland + UK', codes: ['de', 'at', 'be', 'bg', 'hr', 'cy', 'cz', 'dk', 'ee', 'fi', 'fr', 'gr', 'hu', 'ie', 'it', 'lv', 'lt', 'lu', 'mt', 'nl', 'pl', 'pt', 'ro', 'sk', 'si', 'es', 'se', 'is', 'no', 'ch', 'gb'] },
};

function getCountry(code) {
  return COUNTRIES[String(code || '').toLowerCase()] || null;
}

function listCountries() {
  return Object.entries(COUNTRIES).map(([code, c]) => ({ code, name: c.name }));
}

function listPresets() {
  return Object.entries(PRESETS).map(([key, p]) => ({ key, label: p.label, codes: p.codes }));
}

/**
 * Returns true if the location string refers to any of the allowed country codes.
 * Strategy:
 * 1. Amazon-style "CC, State, City" → match if CC ∈ allowedCodes.
 * 2. Reject if a different country's CC appears in "XX, " format anywhere in the string.
 * 3. Accept if any allowed country's name/aliases/cities/regions appear.
 * 4. Accept ", DE" / "(DE)" ISO suffix patterns for any allowed code.
 */
function isAllowedLocation(location, allowedCodes) {
  if (!location || typeof location !== 'string') return false;
  if (!Array.isArray(allowedCodes) || allowedCodes.length === 0) return false;

  const codes = allowedCodes.map(c => String(c).toLowerCase());
  const codeSet = new Set(codes);
  const allKnownCodes = new Set(Object.keys(COUNTRIES));
  const loc = location.toLowerCase().trim();
  if (!loc) return false;

  // Amazon "CC, State, City" — first two letters before a comma = country code
  const amazonPrefix = loc.match(/^([a-z]{2}),\s/);
  if (amazonPrefix) return codeSet.has(amazonPrefix[1]);

  // Reject if a known non-allowed CC appears in "XX, " format
  const codePattern = /(?:^|,\s*)([a-z]{2}),\s/g;
  let m;
  while ((m = codePattern.exec(loc)) !== null) {
    if (allKnownCodes.has(m[1]) && !codeSet.has(m[1])) return false;
  }

  // Accept ISO suffix patterns ", XX" or "(XX)" for any allowed code
  for (const code of codes) {
    if (new RegExp(`,\\s*${code}\\b`).test(loc)) return true;
    if (new RegExp(`\\(${code}\\)`).test(loc)) return true;
  }

  // Accept if any positive term from any allowed country matches
  for (const code of codes) {
    const c = COUNTRIES[code];
    if (!c) continue;
    if (c.aliases.some(a => loc.includes(a))) return true;
    if (c.cities.some(a => loc.includes(a))) return true;
    if (c.regions.some(a => loc.includes(a))) return true;
  }

  return false;
}

/**
 * Returns a label suitable for passing to Apify scrapers as the `location` field.
 * If a single country is allowed, returns its English name (e.g. "Germany").
 * If multiple, returns "Europe" — most actors accept that as a region search.
 */
function locationLabelFor(allowedCodes) {
  if (!Array.isArray(allowedCodes) || allowedCodes.length === 0) return 'Germany';
  if (allowedCodes.length === 1) {
    const c = getCountry(allowedCodes[0]);
    return c ? c.name : 'Germany';
  }
  return 'Europe';
}

function primaryCountryCode(allowedCodes) {
  if (!Array.isArray(allowedCodes) || allowedCodes.length === 0) return 'de';
  return String(allowedCodes[0]).toLowerCase();
}

module.exports = {
  COUNTRIES, PRESETS,
  getCountry, listCountries, listPresets,
  isAllowedLocation, locationLabelFor, primaryCountryCode,
};
