# Haze Tracker

A progressive web app showing Singapore's air quality from NEA (via data.gov.sg): 24-hour PSI and 1-hour PM2.5 for the Central, North, South, East and West regions, with an optional alert when a reading crosses a threshold you set.

## Run / deploy
Static files only, no build step. It needs HTTPS to install and notify, so the easiest host is GitHub Pages (Settings, Pages, deploy from `main`, root folder). Locally: `python3 -m http.server` and open `http://localhost:8000`.

## Install on a phone
- Android Chrome: menu, Install app (or the in-page button).
- iPhone Safari: Share, Add to Home Screen. Notifications on iOS only work from the installed app (iOS 16.4+).

## Alerts
Pick a region (or the highest region across Singapore), a reading (24-hr PSI or 1-hr PM2.5) and a threshold. A notification is sent when the reading rises from below the threshold to at or above it. There is no server, so checks run while the app is open, and in the background on Android Chrome when installed (browser-scheduled, roughly hourly). Reliable push while the app is fully closed would need a small backend.

## Files
`index.html`, `styles.css`, `app.js` (UI), `shared.js` (API + alert logic, also used by the service worker), `sw.js` (offline cache, background checks), `manifest.webmanifest`, `icons/`.
When changing cached files, bump `CACHE` in `sw.js`.

Data: National Environment Agency, Singapore Open Data Licence.
