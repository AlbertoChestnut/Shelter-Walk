// The views a computer can land on when someone opens the site. Phones always
// get the volunteer app; on a computer each person picks a start page
// (Settings, or the switcher at the top of the desktop pages), stored as
// users.desktop_view. Without a choice, staff land on the staff dashboard and
// everyone else on the app (how it worked before this setting existed).
//
// To add a desktop page: add it here, serve it at `path`, and put the
// switcher on it (public/js/desk-nav.js).
const VIEWS = [
  { key: 'app', label: 'Volunteer app', path: '/app' },
  { key: 'playgroup', label: 'Play group desk', path: '/playgroup' },
  { key: 'staff', label: 'Staff dashboard', path: '/staff', staffOnly: true }
];

// Good enough to tell phones from computers, not anything security-sensitive.
// iPadOS Safari's UA doesn't look mobile, so an iPad counts as a computer.
const MOBILE_UA_RE = /Mobi|Android|iPhone|iPod|Windows Phone/i;
const isMobile = (req) => MOBILE_UA_RE.test(req.headers['user-agent'] || '');

const available = (isStaff) => VIEWS.filter((v) => !v.staffOnly || isStaff);
const isValid = (key, isStaff) => available(isStaff).some((v) => v.key === key);

// The view this person starts on: their choice if they can still have it,
// otherwise the default for who they are.
function startView(chosen, isStaff) {
  if (chosen && isValid(chosen, isStaff)) return chosen;
  return isStaff ? 'staff' : 'app';
}
const pathFor = (key) => (VIEWS.find((v) => v.key === key) || VIEWS[0]).path;

module.exports = { VIEWS, available, isValid, startView, pathFor, isMobile };
