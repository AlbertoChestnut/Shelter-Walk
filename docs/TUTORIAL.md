# How to use Shelter Walk

Shelter Walk shows which dogs need a walk, lets you check a dog out by
scanning the QR code or barcode on their kennel card, and times the walk. The most
important part is [scanning a dog for a walk](#scanning-a-dog-for-a-walk).

The scanning example is a real kennel card (Axel Rose). The other dogs in
the screenshots are made-up demo dogs. To regenerate them, see
`app/smoke/tutorial-shots.js`.

<!-- This file and app/public/tutorial.html (the copy the app shows) have the
same text, section by section; change both together. Screenshots:
app/smoke/tutorial-shots.js writes the PNG originals to docs/tutorial/, and
the app serves smaller JPEG copies of the same files from
app/public/tutorial/. -->

## Getting started

1. **Sign in** with the invite link from the volunteer coordinator.
2. **Add it to your Home Screen.** On iPhone, use Safari's Share button,
   then Add to Home Screen. On Android, use Chrome's menu, then Install app.
   Walk alerts on iPhone only work from the Home Screen app.
3. **Enter your name.** Other volunteers see it only while you are out with a dog.
4. **Pick your experience level.** It decides which dogs show as ready for
   you. If you're not sure, choose Beginner. You can change it later in Settings.

<p>
<img src="tutorial/01-welcome-name.png" width="260" alt="Welcome screen asking for your name">
<img src="tutorial/02-welcome-experience.png" width="260" alt="Experience level picker">
</p>

| Level | Who | Dogs you're cleared for |
| --- | --- | --- |
| Beginner | Under 20 hours volunteering | 15+ days in the shelter, no blue behavior markers, no Potty break only dogs, no dogs mid-adoption |
| Established | 20+ hours | 7+ days in the shelter, blue markers and PB dogs allowed |
| Experienced Volunteer | 1 year and 100+ hours | Everything Established can walk, plus EVO (Experienced Volunteers Only) dogs |

Puppies under 6 months old can't be walked by anyone. Dogs on **stray hold**
can't be walked at any level unless they also have a PB sticker (a PB walk, so
Established and up) or a privileged volunteer has cleared a returned dog from
the hold. Dogs listed as **in foster** aren't at the shelter, so they never
show as eligible; if you have one's kennel card in hand, the app asks you to
check it matches before you start.

**Walking hours:** dogs can be walked during the shelter's walking hours,
usually **7am to 7pm**. Staff can change them or close the shelter for a day,
and the app shows a notice when you open it on a day like that. The app won't
start a walk outside walking hours, and any walk still going at closing time
ends then.

## Scanning a dog for a walk

Tap **Scan**, point your phone at the QR code or barcode on the kennel card, check the
dog's screen, then tap **Start walk**. The app reads the code by itself, so
there's nothing to press.

### 1. Open the camera

Tap **📷 Scan** in the bottom bar. The camera opens right away. The first
time, your phone asks for camera access, so tap **Allow**.

### 2. Scan the QR code or the barcode on the kennel card

Every kennel card has **two codes, and either one works.** Both hold the
dog's Animal ID, so they open the same dog. Use whichever is easier to reach
or less scuffed.

- The **QR code** is the small square near the top right, next to the dog's photo.
- The **barcode** is the set of vertical lines under the breed and colors.

<img src="tutorial/05-kennel-card.png" width="420" alt="Axel Rose's kennel card with the QR code and barcode outlined">

Fit the code inside the green corners and hold still for a second. The app
reads it by itself. Move closer if the code looks small, and tilt the phone
if the plastic sleeve shows glare. For the barcode, fit every line inside
the corners, edge to edge.

<p>
<img src="tutorial/06-scan-camera-qr.png" width="260" alt="Scanning Axel Rose's QR code">
<img src="tutorial/07-scan-camera-barcode.png" width="260" alt="Scanning Axel Rose's barcode">
</p>

### 3. Check it's the right dog

Match the name and ID number to the kennel card. Axel Rose's card says
**Animal ID: 262826**, and so does the app. Then read the badge under the name:

- Green **Eligible to walk ✓**: you're cleared for this dog.
- **⚠ Warning** on a striped background: you're not cleared for this dog at
  your level. The badge says why, such as "Experienced Volunteers Only" or
  "Needs 4 more days in shelter". Pick a different dog.
- Solid red with **🚫 Too young to walk**: puppies can't go out. The button is locked.
- Yellow **Potty break only** banner: a short, potty-focused walk only.

<p>
<img src="tutorial/08-scan-dog-found.png" width="260" alt="Axel Rose found after scanning, eligible to walk">
<img src="tutorial/15-scan-not-cleared.png" width="260" alt="Dog you're not cleared for, with caution stripes">
<img src="tutorial/16-scan-too-young.png" width="260" alt="Puppy too young to walk">
</p>

### 4. Read the tips

Shared tips from other walkers and your own private notes are right under the
dog. Tap a sticker to see what it means.

- Add a **tip** from the dog's info for other walkers: what works, what to
  watch for. Everyone sees tips, and they never show who wrote them.
- **My private notes** are reminders just for you. Nobody else can see them,
  not even staff.
- Type **@** and a name in any note to tag another dog or cat, such as a
  kennel or condo mate. The tag shows as their name (tap it to open them),
  and the note also appears on their notes under **Tagged in other notes**.
  A tag in a private note stays private.
- Tap the dog's photo to open their full info.

### 5. Fix anything that's changed, then start

If the kennel card's stickers or kennel letter differ from the app, tap them
to match. **Save changes** appears only when something changed, and Start
Walk saves it too.

Tap **Start walk**. If you're cuddling, at matchmaking, at play group, or
taking the dog on a 🚗 daycation instead, tap **⇄ Change** first and pick
that. A daycation can last up to 12 hours, so it doesn't stop after 45
minutes the way a walk does. Set your **usual activity** in Settings so the
button starts with it. Already out and doing something different? Pick it
under **Doing something else?** on the timer screen, or fix it later in
Stats&Notes.

<p>
<img src="tutorial/09-scan-start-walk.png" width="260" alt="Markers, kennel location and Start walk button">
<img src="tutorial/10-scan-change-activity.png" width="260" alt="Choosing walk, cuddle, matchmaking or play group">
</p>

### 6. Write the check-out time on the kennel

The big time at the top is your check-out time. The screen also shows
**Return to:** with the kennel letter and a running timer.

A walk stops by itself after 45 minutes (matchmaking after 60). Tap
**＋10 min** to extend it, up to 3 hours in total. If the limit stops a walk, the app asks when it really ended next
time you open it.

<img src="tutorial/11-walk-in-progress.png" width="300" alt="Walk in progress with check-out time and timer">

### 7. End the walk

Bring the dog back and tap **End walk**. The walk ends when you tap it, not
when you save. Add an optional note for other walkers (shared without your
name) and a private note, using **@** to tag any other dog or cat the note
is about, then tap **Save & finish**. **Scan next dog** takes
you straight back to the camera.

<p>
<img src="tutorial/12-walk-end-notes.png" width="260" alt="Notes after ending a walk">
<img src="tutorial/13-walk-complete.png" width="260" alt="Walk complete screen">
</p>

### If the code won't scan

Type the dog's name in **Search by name instead** under the camera. Tap the
dog, and you land on the same screen as a scan.

<img src="tutorial/14-scan-search-by-name.png" width="300" alt="Searching for a dog by name">

**Scanned the wrong dog?** Tap **Scan a different dog**, or your phone's Back
button, to return to the camera. Nothing starts until you tap Start walk.

## The other screens

Four tabs run along the bottom: Available, Scan, Stats&Notes and Updates. Three
buttons sit at the top right: 👤 your account, 📖 the Guide, and ⚙ Settings.

### 🐾 Available

Lists every dog, with stickers, days in the shelter, kennel letter, green boxes
for walks logged in the app this shift, and an Eligible badge. Not everyone uses
the app, so an empty box doesn't mean a dog hasn't been out. Tap **▶ Start / Edit** to open a dog the same way a
scan does, **View info** for their profile, or 🕘 for walk history (your own walks are
marked, and nobody else is named). Tick
**Out** if a dog was already walked today outside the app.

Tap **Filters** to narrow the list by kennel wing, sex, age, breed, stickers,
"Dogs I've walked before", or hiding dogs with a walk logged this shift.
**Advanced filters** add home compatibility (other dogs, cats, children),
size, heartworm, stray hold, video and days in the shelter. Ready-made
combinations are under **Presets**, such as Beginner, POO Dogs and Non-POO
Dogs, and you can save your own there too.

<p>
<img src="tutorial/03-available.png" width="260" alt="Available dogs list">
<img src="tutorial/04-available-filters.png" width="260" alt="Available filters">
<img src="tutorial/17-dog-info.png" width="260" alt="Dog profile">
</p>

### 📝 Stats&Notes

**My stats** shows your walks today and over your lifetime. Tap ✎ to fix a
walk's times or 🗑 to delete it. **Together** shows anonymous totals for the
whole shelter, with no names and no rankings. **Notes** gathers the tips and
notes for every animal in one place (all of them, or just yours), and **Play
group** has every dog's play group notes.

If you volunteer with both dogs and cats, pick **🐕 Dogs** or **🐈 Cats** under
the tabs to see one kind of animal at a time. Each view breaks the numbers
down by engagement type (walks, cuddles, matchmaking, play group,
daycations). Dogs are also split into POO and non-POO, going by the sticker
the dog had at the time, and cats into kittens and adults. **Shelter** shows
how many are at the shelter now (including how many dogs are walkable at
your level) and how many are in foster, and charts both day by day, along
with how many come in and get adopted.

<p>
<img src="tutorial/18-stats.png" width="260" alt="My stats">
<img src="tutorial/19-stats-together.png" width="260" alt="Together stats">
</p>

### 📣 Updates, 📖 Guide, ⚙ Settings, 👤 My account

- **Updates:** dogs that arrived, came back, or were adopted. Choose which
  kinds show in Settings.
- **Guide:** what every sticker means, tips for new volunteers, experience
  levels, and shelter contacts.
- **Settings:** experience level, usual activity, light or dark theme,
  notifications (such as a reminder of where to return your dog), and
  walk-length alerts (up to 3, e.g. 7 and 10 minutes).
- **My account:** change your name, hide your name while walking, download or
  delete your data, and sign out.

<p>
<img src="tutorial/20-updates.png" width="200" alt="Updates feed">
<img src="tutorial/21-guide.png" width="200" alt="Guide">
<img src="tutorial/22-settings.png" width="200" alt="Settings">
<img src="tutorial/23-account.png" width="200" alt="My account">
</p>

## Troubleshooting

| Problem | Fix |
| --- | --- |
| "Camera access is blocked" | **Android:** open Chrome, then Menu, Settings, Site settings, and search "shelterwalk.com". Set Camera to Allow, then reopen the app. **iPhone:** open the Settings app, then Safari, then Camera. Set it to Ask or Allow, then reopen the app. Until then, use Search by name. |
| The camera shows the code but nothing happens | Hold the phone 6–12 inches away, keep the whole code inside the green corners, and avoid glare. If one code is damaged, scan the other one: QR code or barcode. If both are, search by name. |
| "Could not read a dog ID from that code" | You scanned something other than a kennel tag. Scan the dog's kennel card, or search by name. |
| "New kennel card · We don't have this dog's details yet" | The shelter printed the card before adding the dog to its online listing. Pick the kennel letter and tap **Start walk** as usual, after checking the card's age and stickers yourself. The walk is kept under the card's Animal ID and added to the dog's record once the listing has them (it's checked every 30 minutes). |
| The dog's screen shows the wrong dog | Tap **Scan a different dog** and scan again. Tell staff if a kennel card has the wrong dog's code. |
| You forgot to end a walk | It stops by itself at the time limit. Next time you open the app, choose when it really ended: Just now, At the limit, or Pick a time. |
| A finished walk has the wrong times | Go to **Stats&Notes**, find the walk, tap ✎ and fix it. |
| No walk alerts on iPhone | Add the app to your Home Screen, open it from there, and turn alerts on in Settings. |
