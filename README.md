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

## Signing in and setting up your profile

The first time you open the app, you'll see a **Sign in** screen — enter the email and password created for you in step A2. There's no "forgot password" self-service link in this simple version; if you ever get locked out, reset it from the Firebase console under Authentication → Users.

Right after your first sign-in, you'll be asked **"Who's this?"** with buttons for each name on file (Saubhik / Tanuka by default). Tap your own name. This is important — it's how the app knows what belongs to you, especially for the Finance sharing feature below. You only do this once per device; if you ever need to redo it (e.g. you tapped the wrong name), go to **Settings → Your profile → Change profile**.

## The five main tabs (bottom of the screen)

### 🏠 Home (Dashboard)

This is the first thing you see — your wedding countdown, upcoming events, and a live snapshot of budget, guests, and tasks.

- **Needs attention** — anything urgent: overdue tasks, vendor payments coming due, guests who haven't RSVP'd close to the date. Tap any alert to jump straight to it.
- **Your events** — every event you've added in Settings (Haldi, Wedding, Reception, etc.), showing the date, time, venue, and how many guests are expected at that specific event.
- **Budget** — the big number is what's left to pay, followed by Contracted / Paid / Planned. This only counts vendors *you* can see the finances for (more on that below).
- **Guests** and **Tasks** — quick totals.

### ✅ Tasks

Your wedding to-do list.

- Tap the **circle** on the left of any task to mark it done instantly — no need to open anything.
- Tap the task itself (not the circle) to edit details: title, priority, due date, linked vendor, notes.
- Use the filter chips at the top (All / Pending / In Progress / Overdue / Completed) to narrow the list.
- The **+** button (bottom right) adds a new task.

### 🏛 Vendors

Every vendor you're working with — photographer, caterer, venue, etc.

- Tap **+** to add a new vendor: name, category, contact person, phone, and the total contract amount.
- Tap an existing vendor to open its details: contract progress bar, its payments (read-only here — see Finance to record one), and a **Documents** section where you can attach contracts, quotations, or screenshots (photo or PDF, up to 8MB each).
- **Sharing a vendor's finances**: inside a vendor's edit screen, there's a "Share this vendor's finances" toggle. By default, a vendor's contract amount and payments are private — visible only to whoever created it. Turn the toggle on and pick names to share it with (e.g. share "Wedding Photography" with Tanuka), and now she'll see that vendor's numbers too. Anyone not on the sharing list still sees the vendor exists (for coordinating tasks, contact info, etc.) but sees "🔒 Finance details are private" instead of the amounts.

### ₹ Finance

This is where money actually gets tracked. It's organized into four parts, top to bottom:

1. **Overview** — Contracted / Paid / Planned / Remaining, totalled only across what's shared with you or created by you.
2. **Payments** — every individual payment, across all vendors, newest first. Tap **"+ Record payment"** at the top of this section to log one:
   - Choose the vendor, enter the amount, then choose **Already paid** or **Planned for later**.
     - **Already paid** asks who paid and the date it was paid.
     - **Planned for later** asks for the expected date instead — nothing about "who paid" yet, since it hasn't happened.
   - Tap **Save payment**.
   - Tap any payment in the list afterward to open its details — you can edit the amount/date/note, attach the receipt or bill for *that specific payment* (its own photo/PDF, separate from the vendor's general documents), or delete it. If it was "Planned," there's a **"Mark as paid now"** button right there once it actually happens.
3. **Vendors & contracts** — a quick-glance list of every vendor's paid-vs-contracted amount (or "🔒 Private" if it's not shared with you). Tap one to jump to its full vendor page.
4. **Other expenses** — anything not tied to a specific vendor (e.g. a small cash purchase). Tap **"+ Add"** next to the heading. These can also be marked shared/private the same way as vendors.

**Why can't I see some numbers?** If a vendor or expense shows "🔒 Private," whoever created it hasn't shared it with your profile. Ask them to open that vendor/expense and add your name under its sharing toggle.

### 💌 Guests

Your guest list.

- Tap **"Import from Excel/CSV"** to bring in an existing spreadsheet. Your file's first row should be column headers — the app looks for columns like Name, Phone, Adults, Children, Cohort (or "Invited to"), RSVP, and Notes, and matches them automatically. You'll see a preview (how many new guests, how many look like duplicates already in your list) before anything is actually added.
- Each guest has a **cohort**: *Full Wedding* (invited to everything) or *Reception Only*.
- Tap the **RSVP badge** on the right of a guest's row to cycle it through Pending → Confirmed → Declined without opening the full form. Tap the guest's name/row itself to edit all their details.
- Filter chips at the top narrow by RSVP status or cohort.

## ⚙️ Settings

- **Wedding details** — the wedding and reception dates used for the countdown.
- **Events** — add every function you're holding (Haldi, Sangeet, Wedding, Vidaai, Reception, whatever your family does), each with its own date, time, venue name, address, and who's invited (*Full Wedding guests* or *Everyone*). These show up as decorated cards on the Dashboard, along with an automatic headcount based on your guest list.
- **People** — the list of names used throughout the app (as payers, and as sharing targets in Finance). Add or remove names here if your household needs more than two.
- **Account** — shows who you're signed in as and which profile (Saubhik/Tanuka) you've picked on this device, with a button to change it.
- **Data** — **Export backup** downloads a `.json` snapshot of everything, useful as an extra safety net even though your data already lives safely in the cloud. **Import backup** restores from such a file (this replaces all current data, with a confirmation first). **Erase all data** wipes everything — used only if you really want to start over.

## Things worth knowing

- **Offline works.** If you lose signal mid-edit, your change is saved on your phone and quietly syncs to the cloud (and to Tanuka's phone) the next time you're back online. You'll see a small "Syncing…" pill in the top right while that happens.
- **Both of you editing at once** is fine for everyday use — changes merge in as they arrive. If you both happen to edit the exact same field within a second of each other, the last save wins; this is not a concern for normal day-to-day planning.
- **Nothing is ever deleted quietly.** Deleting a task, vendor, guest, payment, or document always asks you to confirm first.
