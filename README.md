# Wedding Secretary — User Manual

This is your private wedding planning app for Saubhik & Tanuka's wedding. It lives on the web (so it works on any phone or computer with a browser), installs like a real app on Android, keeps your data synced across every device you sign into, and still works with no signal.

This guide has two parts:
- **Part A — Setup** (do this once, takes about 20 minutes total)
- **Part B — How to use the app** (a full walkthrough of every screen, written for someone who's never used it before)

---

# Part A — Setup

You need three free accounts before this works: **Firebase** (the database), **Cloudinary** (for photo/document uploads), and **GitHub** (to host the actual website). None of them need a credit card.

## A1. Create your free Firebase project

1. Go to [console.firebase.google.com](https://console.firebase.google.com) → **Add project** → name it (e.g. `wedding-secretary`) → keep default settings → **Create project**.
2. In the project, click the **</> (Web)** icon to register a web app. Give it any nickname. You don't need Firebase Hosting — you're using GitHub Pages instead.
3. Firebase shows you a `firebaseConfig` object with values like `apiKey`, `authDomain`, etc. Keep this tab open — you'll paste these into a file in step A4.

## A2. Turn on Authentication (this controls who can sign in)

1. Left sidebar → **Build → Authentication → Get started**.
2. Under **Sign-in method**, enable **Email/Password**.
3. Go to the **Users** tab → **Add user** → create an account for yourself (an email + a password you choose). Repeat to create one for Tanuka.
   - There's no public "Sign up" button in the app — the only way anyone gets an account is you creating it here. This is what keeps your data private to just the two of you.

## A3. Turn on Firestore (the actual database)

1. **Build → Firestore Database → Create database**. Pick a region close to you, start in **production mode**.
2. Go to the **Rules** tab, replace everything with:
   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /{document=**} {
         allow read, write: if request.auth != null;
       }
     }
   }
   ```
   This means: only someone signed in can read or write anything. Click **Publish**.

## A4. Add your Firebase config to the app

Open the file `firebase-config.js` and replace the placeholder values with the real ones from step A1.3:
```js
export const firebaseConfig = {
  apiKey: "...",
  authDomain: "...",
  projectId: "...",
  storageBucket: "...",
  messagingSenderId: "...",
  appId: "..."
};
```
Save the file.

## A5. Set up Cloudinary (for vendor documents and payment receipts)

Firebase's own file-storage product now requires a paid billing plan just to switch on, even though actual usage stays free — so this app uses Cloudinary instead, which is genuinely free with no card needed.

1. Go to [cloudinary.com](https://cloudinary.com) → sign up for a free account.
2. On your Cloudinary dashboard, copy the **Cloud name** shown near the top.
3. Go to **Settings (gear icon) → Upload → Upload presets → Add upload preset**.
4. Set **Signing Mode** to **Unsigned**, give it a name (e.g. `wedding_docs`), and **Save**.
5. Open `cloud-config.js` and fill in:
   ```js
   export const CLOUDINARY_CLOUD_NAME = "your-cloud-name";
   export const CLOUDINARY_UPLOAD_PRESET = "wedding_docs";
   ```

One small tradeoff: because uploads happen straight from the browser without a secret key, the app can remove a document from its own list, but can't also delete the underlying file from Cloudinary's storage. At the scale of a wedding's worth of PDFs and photos (a handful of megabytes against a 25GB free allowance) this will never matter in practice.

## A6. Put it on GitHub Pages

1. Go to [github.com/new](https://github.com/new) → create a repository, e.g. `wedding-secretary`.
2. Upload all the app files: `index.html`, `app.js`, `firebase-config.js`, `cloud-config.js`, `manifest.json`, `sw.js`, `icon-192.png`, `icon-512.png`, this `README.md`.
   - Easiest way with no command line: on the repo page, **Add file → Upload files**, drag them all in, **Commit changes**.
3. **Settings → Pages** → Source: **Deploy from a branch** → Branch: `main` / `root` → **Save**.
4. Wait about a minute, refresh — you'll get a link like `https://YOUR-USERNAME.github.io/wedding-secretary/`. That's your live app.

## A7. Install it on your (and Tanuka's) phone

1. Open the link in **Chrome** on the phone.
2. Tap **⋮ → Add to Home screen** (or tap the "Install app" banner).
3. Open the installed app — it now behaves like a normal app: its own icon, full-screen, works offline.

---

# Part B — How to use the app

## Signing in

Enter the email and password created for you in step A2. There's no "who are you" screen anymore — the app knows who you are from your login itself, and automatically tracks what you've added versus what's shared with you. If you're ever locked out, reset your password from the Firebase console under Authentication → Users.

## The five main tabs (bottom of the screen)

### 🏠 Home

This splits into two swipeable panels at the top:

- **🎉 Celebrations** — a decorated view of every wedding function (Haldi, Wedding, Sangeet, Vidaai, Reception, whatever you've set up), each showing its date, time, venue, address, and how many guests are expected — pulled automatically from your guest list. The main Wedding-day event also shows how many guests are staying for Bashor Raat.
- **📊 Overview** — the countdown, budget snapshot, guest totals, and task totals — the numbers-focused view.

### ✅ Tasks

Shared between everyone with access — your joint wedding to-do list.

- Tap the **circle** to mark a task done instantly.
- Tap the task itself to edit title, priority, due date, linked vendor, notes.
- Filter chips at the top narrow by status.

### 🏛 Vendors

Private by default — vendors you add are visible only to you until you explicitly share them.

- Tap **+** to add a vendor: name, category, contact, phone, contract amount.
- Tap an existing vendor to see its contract progress, payments, and attach documents (contracts, quotations, screenshots — photo or PDF, up to 8MB).
- **Sharing**: every vendor has a "Share this" toggle. Turn it on and pick names from the list of people who have signed in — now they can see that vendor's numbers too. Nobody else sees anything beyond "🔒 Finance details are private."
- You can only share with someone who has signed in at least once (so their name can appear in the picker). If Tanuka hasn't logged in yet, add her account and have her open the app once — she'll then show up as a shareable person everywhere.

### ₹ Finance

1. **Overview** — Contracted / Paid / Planned / Remaining, totalled only across what's shared with you or created by you.
2. **Payments** — every payment, newest first. Tap **"+ Record payment"**: choose the vendor, the amount, then **Already paid** (asks who and when) or **Planned for later** (asks only for an expected date). Tap any payment afterward to edit it, attach its own receipt, or mark a planned one as paid once it happens.
3. **Vendors & contracts** — quick glance at paid-vs-contracted per vendor (or "🔒 Private" if not shared with you).
4. **Other expenses** — anything not tied to a vendor, shareable the same way.

### 💌 Guests

Each event has its **own separate guest list** — Haldi, Wedding, Reception, etc. all keep independent lists, so the same person can be on one, some, or all of them, and (for example) each side of the family can keep their own Haldi list private if that's ever needed via that event's sharing setting. The one exception: **Wedding and Bashor Raat share one list** — there's no separate "Bashor Raat" event, it's just an extra toggle on a guest within the Wedding list.

- **Switching lists**: at the top of the Guests tab, tap an event name to switch which list you're viewing/editing.
- **Tags**: every guest belongs to a Tag (a group like "Family," "Baba's Invitee," "Abash Family" — whatever categories you use). The list shows guests grouped under their tag with a running headcount subtotal, and you can tap a tag's header to collapse or expand that group.
- **Adding a guest**: Tag, Name (can be a combined name like "Shantanu + Wife" for one row covering multiple people), an Adults headcount, and an Invited toggle (whether the invite has been sent). If you're on the Wedding list, there's also a "Staying for Bashor Raat?" toggle.
- **Quick toggle**: tap the "Invited / Not yet" badge directly on a guest's row to flip it without opening the form.
- **Filter**: All / Invited / Not yet invited, for whichever list you're currently viewing.

**Importing your existing guest list:**
- **From Excel/CSV**: use column headers `Tags`, `Name`, `Adults` (also recognizes `Total Attending`, `Headcount`, `Pax`, etc.), and `Invited` (Tags is optional — if a row's Tags cell is blank, it's treated as continuing the same group as the row above it, which matches how a grouped spreadsheet usually exports). A `Baashor Stay` / `Bashor Raat` column is also recognized and imported automatically when present. Pick which event you're importing into first (the event tab you have selected), then choose your file.
- **From Apple Numbers**: Numbers' own file format can't be read directly by a web app — there's no reliable way to parse it in-browser. Open your sheet in Numbers, then **File → Export To → Excel (or CSV)**, and import that exported file exactly as above. If your sheet uses Numbers' "Organize by Category" grouping (like the Tags column in your screenshot), the exported file should carry the category into every row automatically — if it doesn't, the blank-row carry-forward described above will still handle it.
- **From JSON**: for a scripted or hand-built import, the app accepts:
  ```json
  {
    "tags": [
      { "name": "Abash Family", "guests": [
        { "name": "Bachchan Da", "adults": 3, "invited": false },
        { "name": "Sandip Da", "adults": 1, "invited": false }
      ]},
      { "name": "Baba's Invitee", "guests": [
        { "name": "Amit Bhattacharjee", "adults": 2, "invited": false }
      ]}
    ]
  }
  ```
  A flat array of `{"tag":"...", "name":"...", "adults":N, "invited":true|false}` objects also works.
- **PDF isn't supported** — reliably pulling a table back out of a PDF in-browser isn't practical to do well; export to Excel/CSV/JSON instead.
- Either way, guests that already exist by name in that event's list are skipped as duplicates rather than re-added.
- A **Confirmed?** column, if your sheet has one, is currently not imported — the app only tracks Invited (sent) vs. not, not RSVP confirmation. Let your planner know if you'd like that added back as a separate tracked field.

## ⚙️ Settings

- **Wedding details** — dates used for the countdown.
- **Events** — add every function you're holding, each with date/time/venue/address, a sharing toggle (in case, say, the bride's side Haldi details should stay private to one side until finalized), and a "this is the main Wedding day" flag that unlocks Bashor Raat tracking.
- **People with access** — everyone who's ever signed in, shown automatically. To add someone new, create their account in the Firebase console (step A2) — no in-app invite step needed.
- **Account / Data** — sign out, export/import backup, erase everything.

## Things worth knowing

- **Offline works.** Changes save locally first and sync once you're back online.
- **Signing out clears this device's cache** and reloads fresh — use this if the app ever looks out of date after you've pushed an update to GitHub.
- **Privacy note:** vendor/expense/event privacy is enforced by the app's own logic, checked against who you're signed in as. It is not the same as bank-grade encryption — a third person who somehow obtained valid sign-in credentials and dug through browser developer tools could theoretically see data not shared with them. For a private wedding between trusted family members, this is a reasonable and normal level of protection; it's just worth knowing this isn't a bank vault.
- **First time opening this version:** whoever opens the app first "claims" any vendors/expenses/events that existed before this update (they become that person's private items, exactly as they appeared before). Anything added after that point follows the new private-by-default rule properly from the start.
