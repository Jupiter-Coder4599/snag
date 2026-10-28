# Snag

Share an Instagram or X post to Snag and its photos and videos save to your gallery.
Snag only talks to the site the post is from: Instagram (with your own login) or
X (its public embed service, no login). No outside servers.

- PIN lock: downloads unlock for 45 minutes at a time.
- Saved media table: account, site, photo or video, and time for every file.
- Files from any server that isn't the site's own are blocked and logged.

Android app, Expo SDK 57. Builds on GitHub Actions (`.github/workflows/android.yml`),
signed with the key in the `ANDROID_KEYSTORE_BASE64` repo secret.

## Updating the repo from this zip

1. On github.com: **Add file > Upload files**, upload `snag.zip`, **Commit changes**.
2. Open your codespace (**Code > Codespaces**), then in the terminal, one at a time:

       git pull
       unzip -o snag.zip
       cp -a snag/. .
       rm -rf snag snag.zip
       npm install
       npx expo install --fix
       npx expo-doctor
       git add -A
       git commit -m "Update Snag"
       git push

3. **Actions** tab: wait for the green check, download **snag-apk**, install it.

## If you forget the PIN

Android Settings > Apps > Snag > Storage > Clear data. This resets the PIN,
the saved-videos list and the Instagram login. Videos in your gallery stay.

## If Instagram changes something

All the Instagram-specific code is in `instagram.js`.

For personal use only. The creators own their videos.
