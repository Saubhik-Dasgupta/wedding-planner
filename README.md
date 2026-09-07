# Wedding Secretary — Lite

A private wedding planning app for Saubhik & Tanuka, hosted for free on GitHub Pages, backed by a free Firebase cloud database. Sign in on any device (your phone, Tanuka's phone, a laptop) and see the same live data everywhere — it also keeps working offline and syncs once you're back online.

**What's in it:** Dashboard with countdown & live stats, Tasks, Vendors (with contract/payment tracking and document uploads — bills, contracts, screenshots), Finance overview, Guests (with RSVP + cohort tracking, and Excel/CSV import), Settings with backup/restore, sign-in for exactly the two accounts you create.

**What it deliberately leaves out** (compared to the full original spec): no AI secretary, no CSV import, no document vault, no calendar/timeline views. This is the "actually works today, across your devices" version. If you outgrow it, the full phased build discussed earlier is still the path to the complete version.

**Is this secure?** Yes, in the way that matters: nobody can read or write your data without signing in, and you control exactly who has an account (see step 3 below — there's no public sign-up form). The Firebase config values in `firebase-config.js` look like secrets but aren't — Google designs them to be public; real protection comes from Firestore's security rules, which you'll set in step 5.

---

## 1. Create your free Firebase project (5 minutes)

1. Go to [console.firebase.google.com](https://console.firebase.google.com) → **Add project** → name it (e.g. `wedding-secretary`) → keep default settings → **Create project**. This uses Firebase's free "Spark" plan (50,000 reads / 20,000 writes per day) — a personal wedding app won't come close to that.
2. In the project, click the **</> (Web)** icon to register a web app. Give it any nickname. You don't need Firebase Hosting — you're using GitHub Pages instead.
3. Firebase shows you a `firebaseConfig` object with values like `apiKey`, `authDomain`, etc. Keep this tab open — you'll paste these in step 4.

## 2. Turn on Authentication

1. In the left sidebar: **Build → Authentication → Get started**.
2. Under **Sign-in method**, enable **Email/Password**.
3. Go to the **Users** tab → **Add user** → create an account for yourself (email + password). Repeat to create one for Tanuka.
   - There is no public sign-up screen in the app — the only way to get an account is you creating it here. This is what keeps the data private to just the two of you.

## 3. Turn on Firestore (the database)

1. **Build → Firestore Database → Create database**. Choose a region close to you, start in **production mode**.
2. Go to the **Rules** tab and replace the contents with:
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
   This means: only someone signed in (i.e., you or Tanuka) can read or write anything. Click **Publish**.

## 4. Set up Cloudinary (for vendor documents — bills, contracts, screenshots)

Firebase's own Storage product now requires switching your project to a pay-as-you-go plan (a card on file) even to enable it — you're very unlikely to ever be charged at this scale, but if you'd rather not add a card, use Cloudinary instead. It's genuinely free (25GB, no card needed) and takes about 3 minutes:

1. Go to [cloudinary.com](https://cloudinary.com) → sign up for a free account.
2. On your Cloudinary dashboard, copy the **Cloud name** shown near the top.
3. Go to **Settings (gear icon) → Upload → Upload presets → Add upload preset**.
4. Set **Signing Mode** to **Unsigned**, give it a name you'll remember (e.g. `wedding_docs`), and **Save**.
5. Open `cloud-config.js` in the app files and fill in:
   ```js
   export const CLOUDINARY_CLOUD_NAME = "your-cloud-name";
   export const CLOUDINARY_UPLOAD_PRESET = "wedding_docs";
   ```

That's it — no Firebase Storage, no card, no billing plan needed. One small tradeoff: because uploads are "unsigned" (safe to do straight from the browser without exposing a secret key), the app can remove a document from your list but can't also delete the underlying file from Cloudinary itself. At wedding-app scale (a handful of PDFs and photos) this is not something you'll ever need to think about — 25GB is enormous for this use case.

## 5. Add your Firebase config to the app

Open `firebase-config.js` in the app files and replace the placeholder values with the real ones from step 1.3:
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

## 6. Put it on GitHub Pages (5 minutes)

1. Go to [github.com/new](https://github.com/new) and create a new repository — call it `wedding-secretary` (public or private both work; private repos on a free GitHub account can still use Pages).
2. On your computer, open the folder containing these files (`index.html`, `app.js`, `firebase-config.js`, `cloud-config.js`, `manifest.json`, `sw.js`, `icon-192.png`, `icon-512.png`, this `README.md`) and run:
   ```
   git init
   git add .
   git commit -m "Wedding Secretary lite"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/wedding-secretary.git
   git push -u origin main
   ```
   (No `git`/terminal experience? Instead, go to your new repo on GitHub → **Add file → Upload files** → drag in all the files → **Commit changes**.)
3. In the repo, go to **Settings → Pages**.
4. Under "Build and deployment", set **Source** to `Deploy from a branch`, **Branch** to `main` / `root`, then **Save**.
5. Wait ~1 minute, refresh the page — GitHub will show a link like:
   ```
   https://YOUR-USERNAME.github.io/wedding-secretary/
   ```
   That's your app, live.

## 7. Install it on your (and Tanuka's) Android phone

1. Open that link in **Chrome** on the phone.
2. Tap the **⋮** menu (top right) → **Add to Home screen** (or tap the "Install app" banner if it appears).
3. Open the installed app, sign in with the account you created in step 2. It now sits on the home screen as its own app icon, opens full-screen, and works offline.
4. Repeat on Tanuka's phone with her account — you'll both see the same live data.

## 8. Using it day to day

- Any change either of you makes (a task, a payment, an RSVP) syncs to the other's phone automatically, usually within a second or two, as long as both have internet.
- No signal? The app still works — it shows the last-synced data and queues your changes, then syncs them the moment you're back online.
- **Guests → Import from Excel/CSV** lets you bring in your existing guest list. Your file's first row should be column headers — the app auto-detects columns named things like Name, Phone, Adults, Children, Cohort (or "Invited to"), RSVP, and Notes. It shows you a preview (how many will be added, how many look like duplicates of guests already in the list) before anything is actually added — nothing is imported without your confirmation. If a guest's cohort/RSVP column doesn't clearly match "Reception"/"Confirmed"/"Declined" wording, it defaults to Full Wedding / Pending, which you can fix afterward in the guest's own edit screen.
- **Settings → Export backup** still works as an extra safety net — worth doing occasionally regardless.
- If you already used an earlier, non-cloud version of this app and have data you don't want to lose: open that old version one last time, use **Export backup** there, sign into this new version, then use **Import backup** to bring it into the cloud.

## 9. Updating the app later

If you want to tweak anything (colors, add a field, etc.), edit the files and push the change to GitHub (`git add . && git commit -m "update" && git push`, or re-upload via the web UI) — Pages redeploys automatically within a minute. Your phone will pick up the update next time it's online and you reopen the app (the service worker refreshes the cache in the background).
