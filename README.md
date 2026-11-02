# Keells Bill Reader

A web app that reads Keells Nexus e-bills from the screen. Press a button, show a bill, and the app
reads its lines, checks them against the bill total, and shows the result. **Everything is read in the
visitor's own browser:** no picture or bill is sent to the server. The server only hands out these files.

## What it does on each device

| Device | How a bill is read |
|---|---|
| Windows, Mac, Linux, ChromeOS (Chrome, Edge, Firefox, Safari) | **Start screen monitor**: choose the window that shows the bill (for example 3uAirPlayer mirroring the iPhone), then scroll the bill slowly. |
| iPhone, iPad, Android | Phone browsers don't allow a website to watch other apps. Record the screen while scrolling the bill (Control Centre > Screen Recording, or Android's Screen record tile), then open the recording in the app. Screenshots work too. |

Bills are kept in the browser's own storage and can be downloaded as `keells_ebill_items.csv`. The
columns are the same as the CSV made by the PC scripts.

## Hosting

The app is plain static files, so any static host works. It needs **HTTPS**, because browsers only
allow screen capture and offline use on secure pages. These hosts all give you HTTPS for free:

- **GitHub Pages:** create a repository, upload the contents of this folder, then go to
  Settings > Pages and choose "Deploy from a branch" (main, `/ (root)`). The site appears at
  `https://<your-name>.github.io/<repository>/`.
- **Netlify Drop:** open https://app.netlify.com/drop and drag this folder onto the page.
- **Cloudflare Pages:** create a project with "Upload assets" and upload this folder.

To try it on this PC first, run this in the folder, then open http://localhost:8080 (localhost counts as
secure):

```
python -m http.server 8080
```

## Files

| File | What it is |
|---|---|
| `index.html`, `styles.css` | The page |
| `app.js` | Screen capture, recordings, reading frames, saving bills |
| `bill-reader.js` | Turns OCR words into bill lines and puts a bill together from the frames seen while scrolling. It also runs in Node for testing. |
| `sw.js`, `manifest.webmanifest`, `icons/` | Offline use and "Add to Home Screen" |
| `vendor/tesseract/` | Tesseract.js 7.0.0 OCR engine and its English data, served from your own site so no other site is involved |

The first reading downloads about 7 MB (the OCR engine and English data). After that the files come
from the browser's cache.

When you change the app files, visitors get the new version the next time they open the page online.
If you replace the files in `vendor/`, also change `CACHE` in `sw.js` (for example to
`keells-bill-reader-v2`) so browsers drop the old copies.

## Good to know

- Scroll slowly and pause on each screenful. A bill is saved only when its lines add up to the bill
  total. If a line was missed, the app says which one, for example "Scroll back up a little: line 12".
- Make the mirror window large. Small text causes more OCR mistakes. If you share the whole screen
  instead of one window, the app finds the bill by itself. You can also drag on the preview to mark
  where the bill is.
- Amounts are checked against the bill total. Item names can have small OCR slips, for example "10S"
  read as "108".
- A phone takes a minute or two to read a 15-second recording.

## Licences

Tesseract.js and tesseract.js-core are under the Apache License 2.0 (see `vendor/tesseract/`). The
English data comes from the Tesseract project (`tessdata`, Apache License 2.0), packaged as
`@tesseract.js-data/eng`.
