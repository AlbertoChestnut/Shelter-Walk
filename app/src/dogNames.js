// When the shelter renames a dog, volunteers still know them by the old
// name for a while: the app shows "aka <old name>" under the new one and
// searching the old name still finds them. dogs.previous_names holds those
// old names as a JSON array, oldest first.

// Letters and digits only, lowercased, so "'roxy'" and "Roxy" compare equal.
function squash(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Is going from oldName to newName a real rename worth remembering? Not if
// the old name is still in the new one: a spelling fix ("Layla" to "Laylah"),
// or the shelter adding a second name itself ("Johnny" to "Johnny/aspen").
// Not for a kennel-card stand-in's placeholder ("Dog #123") either.
function isRename(oldName, newName) {
  const before = squash(oldName);
  const after = squash(newName);
  if (!before || !after) return false;
  if (/^Dog #\d+$/.test(String(oldName).trim())) return false;
  return !after.includes(before);
}

// The previous_names JSON after a rename from oldName to newName. A dog
// renamed back to an old name drops it from the list.
function withPreviousName(previousJson, oldName, newName) {
  let names = [];
  try { names = JSON.parse(previousJson || '[]'); } catch (e) { names = []; }
  if (!Array.isArray(names)) names = [];
  const old = String(oldName).trim();
  names = names.filter((n) => squash(n) !== squash(newName) && squash(n) !== squash(old));
  names.push(old);
  return JSON.stringify(names);
}

module.exports = { isRename, withPreviousName };
