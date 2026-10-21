// Same made-up server names as the backend's privacy.py (Hide Usernames),
// for names the QAM keeps itself (favorite voice channels).
const ADJ = ["Sunny", "Quiet", "Brave", "Lucky", "Swift", "Cozy", "Bright", "Calm", "Clever", "Gentle", "Happy", "Jolly",
  "Mellow", "Nimble", "Plucky", "Rapid", "Shy", "Sleepy", "Snappy", "Witty", "Bold", "Breezy", "Fuzzy", "Zesty"];
const PLACES = ["Hangout", "Lounge", "Corner", "Clubhouse", "Hideout", "Den", "Arcade", "Cafe", "Garage", "Workshop",
  "Basement", "Treehouse", "Harbor", "Station", "Outpost", "Tavern"];

function hash(s: string) {
  let h = 2166136261;
  for (const b of new TextEncoder().encode(s)) h = Math.imul(h ^ b, 16777619) >>> 0;
  return h >>> 0;
}

export function serverAlias(name: string) {
  if (!name) return name;
  const h = hash("s:" + name);
  return `${ADJ[Math.floor(h / 7) % ADJ.length]} ${PLACES[Math.floor(h / 131) % PLACES.length]}`;
}
