# Snag

Share an Instagram reel or post to Snag and it saves the video to your gallery.
Snag only talks to Instagram, using your own login. No outside servers.

Android app, Expo SDK 57. Stay on SDK 57: expo-share-intent 8.x supports SDK 57
and doesn't list SDK 58 yet.

## 1. Put it on GitHub (from your phone)

1. Extract `snag.zip` in your Files app (My Files: tap the zip, then Extract).
2. On github.com, create a new **private** repository named `snag`. Leave "Add a README" off.
3. On the empty repo page, tap **uploading an existing file**, select every file from
   the extracted folder, and tap **Commit changes**.
   (`.gitignore` may be hidden in your file picker. It's optional.)

## 2. First build (one time, in GitHub Codespaces)

Expo's "Build from GitHub" button only works after one normal build has set up
the project and your app's signing key. Codespaces gives you a terminal in the browser.

4. In the repo, tap **Code > Codespaces > Create codespace on main**.
   If the page is cramped, turn on "Desktop site" in Chrome's menu.
5. In the terminal at the bottom, run these one at a time:

       npm install
       npx expo install --fix
       npx expo-doctor
       npx eas-cli@latest login
       npx eas-cli@latest build -p android --profile preview

   - `expo install --fix` lines every package up with SDK 57. If it changes anything, that's expected.
   - When asked to create an EAS project, answer **Yes**.
   - When asked about a keystore, choose **Generate new keystore**.
6. Save the project link it added to `app.json`:

       git add -A
       git commit -m "Link EAS project"
       git push

7. When the build finishes (about 10 to 20 minutes), open the build link on your phone,
   download the APK, and install it (allow installs from your browser if Android asks).
8. Stop or delete the codespace afterwards so it doesn't use your free hours.

## 3. Later builds (no terminal needed)

On expo.dev, open the snag project > **Settings > GitHub**, install the Expo GitHub app,
and link the `snag` repo. After that: **Builds > Build from GitHub**, pick `main`,
Android, and the `preview` profile.

## 4. Using it

1. Open Snag and tap **Log in** once (username and password; the Facebook button may not work in-app).
2. In Instagram, tap **Share** on a reel, then pick **Snag**.
3. The video saves to your gallery. Carousel posts save every video.

You can also paste a link and tap **Download**. Long-press a row to remove it.
Failed rows have a **Retry** button.

## If Instagram changes something

All the Instagram-specific code is in `instagram.js`.
Snag tries Instagram's web API first, then reads the video address from the post page.

For personal use only. The creators own their videos.
