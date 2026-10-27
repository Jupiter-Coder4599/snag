# Snag

Share an Instagram reel or post to Snag and it saves the video to your gallery.
Snag only talks to Instagram, using your own login. No outside servers.

- PIN lock: downloads unlock for 45 minutes at a time.
- Saved videos table: account, source server and time for every video.
- Videos from any server that isn't Instagram's are blocked and logged.

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
