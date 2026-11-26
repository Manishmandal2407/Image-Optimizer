# Smart Storage Optimizer

A small program that runs **only on your own Windows PC**. It makes JPG and PNG
images smaller so they take less disk space, and it does this **safely**:
nothing happens until you click a button, and every original is copied to a
"vault" and checked before anything is replaced.

Open it in your browser at **http://localhost:4000**.

---

## 1. What you need

- **Windows** and **Node.js** (a current LTS version). Check with `node -v`.
  If `npm install` complains about the Node version, install the newest LTS from https://nodejs.org
- An internet connection for the first install (it downloads libraries).

## 2. Install (once)

Open PowerShell and run:

```
cd C:\Users\pc\Desktop\SSO
npm install
npm --prefix client install
```

The first command installs the server libraries, the second installs the web page libraries.

## 3. Choose your folders (config.json)

Open `config.json` in Notepad:

```json
{
  "imagesFolder": "C:/SSO-test/images",
  "vaultFolder":  "C:/SSO-test/vault",
  "workFolder":   "C:/SSO-test/work"
}
```

- **imagesFolder**: the images to shrink (sub-folders are included). Must already exist.
- **vaultFolder**: where the **originals** are saved before anything is replaced.
- **workFolder**: temporary smaller copies are made here.

Rules:
- Use forward slashes (`C:/Folder/Sub`) or doubled backslashes (`C:\\Folder\\Sub`).
- The three folders must be **different** and **none can be inside another**.
  The app checks this when it starts and refuses to run if they are unsafe.
- Vault and work folders are created for you if they do not exist.

## 4. Run

```
cd C:\Users\pc\Desktop\SSO
npm start
```

Wait for `Server started at http://localhost:4000` (the first part builds the web page, so it takes about half a minute), then open http://localhost:4000. Stop the program with `Ctrl + C` in that window.

## 5. TEST ON A COPY FIRST

Never try this on your real images first.

1. Make a new folder, for example `C:\SSO-test\images`, and **copy** a few photos into it.
2. Point `imagesFolder` in `config.json` at that folder.
3. Run the steps in section 6 and check the results with File Explorer.
4. Only when you are happy, point `imagesFolder` at your real folder. Keep a normal backup of anything important.

## 6. How to use it

1. **Scan** lists the .jpg, .jpeg and .png files with their sizes. It never changes a file.
2. **Make smaller copies** makes a smaller copy (in the work folder) of every image of 500 KB or more, and scores how similar it looks (SSIM). Originals are never touched.
3. **Review** tab: original and smaller copy side by side, with sizes, saving and SSIM. Suggestions:
   - **Green, "Looks the same"**: SSIM is 0.99 or higher (and the saving is 5% or more).
   - **Amber, "Check this one"**: SSIM is lower than 0.99. Look at both pictures.
   - **Red, "Keep original"**: the saving is under 5%, so it is not worth it.
   These are only suggestions. You decide.
4. Per image:
   - **Use smaller version**: the safe replace (see section 7).
   - **Keep original**: just records your choice. No file is touched.
   - **Restore original**: copies the original back from the vault (after checking it).
5. **Replace all green ones (N)** does "Use smaller version" for every green image you have not decided about yet, one at a time, after asking you to confirm. It stops at the first problem.
   **Replace by saving** (also in Review) replaces every image you have not decided about yet whose saving is inside the range you type (it starts at 15 to 20 %) and whose SSIM is 0.95 or higher. It asks you to confirm and stops at the first problem.
6. **Results** tab: every file, what happened, size before and after, and the **total space saved**.

## 7. What "Use smaller version" does, step by step

If any step fails, it stops and tells you in plain words.

1. Copies the original into the vault and checks the copy is identical (SHA-256 fingerprint).
2. Puts the smaller file next to the original under a temporary name (ending in `.tmp`).
3. Swaps it in so the file keeps the **same name, folder and type**.
4. Checks the new file opens and is exactly the smaller copy. If not, it puts the original back.

## 8. Where things are

| What | Where |
|------|-------|
| **The vault (your originals)** | the `vaultFolder` from `config.json`, e.g. `C:\SSO-test\vault`. Same sub-folder layout as your images folder. |
| Temporary smaller copies | the `workFolder` from `config.json` |
| Log of everything the app does | `data\app.log` |
| The app's memory (no database) | `data\state.json` |

**Important:** the vault holds a full copy of every original you replace. You only gain free space on a disk if the vault is on a **different disk** (or another PC's drive) from the images.

The vault copy is never deleted by this program. Do not delete the vault until you are sure you will never want the originals back.

## 9. Good to know

- **JPG** files are re-saved at quality 85. You can change `JPEG_QUALITY` at the top of `src/optimizer.ts` (lower number = smaller file, less quality). Delete the old copies in the work folder and `data\state.json` after changing it, so the copies are made again.
- **PNG** files are re-saved without any quality loss, so the saving is often small and many PNGs will show red.
- Hidden extra information in photos (EXIF, such as camera model and GPS location) is **not** kept in the smaller copy. Sideways photos stay the right way up and colours are kept.
- A replaced file gets a new "date modified" (the time of the swap).
- The similarity score (SSIM) is calculated on a reduced-size version (longest side 1600 pixels) to save memory.
- **Make smaller copies** can take several minutes for big photos. Wait for the message.

## 9b. PDFs (pictures only)

- Open the **Documents** tab and click **Check PDFs**. Nothing is changed.
- **Make smaller copy** shrinks only the big JPEG pictures inside one PDF (quality 85, same size in pixels). Text and everything else stay byte-for-byte the same. The copy goes to `work\pdf\...` and is safety-checked (same pages, same parts, same picture types).
- **Use smaller version** does the same safe steps as for images: original to the vault (SHA-256 checked), smaller file swapped in under the same name, then checked. If the check fails, the original is put back.
- **Keep original** only records your choice. **Restore original** brings the vault copy back (it will not overwrite a file you changed after the replace).
- PDFs that are signed, password-protected or have form fields are skipped. Text-only PDFs are not shrunk.
- Try it on a few **copies** of PDFs first.

## 10. If something goes wrong

| Message | What it means / what to do |
|---------|----------------------------|
| `Cannot reach the server. Is "npm start" still running?` | The server window was closed or crashed. Run `npm start` again. Look at the last lines of `data\app.log`. |
| `imagesFolder does not exist` | Create the folder, or fix the path in `config.json`. |
| `Unsafe folders ...` | Two of your three folders are the same, or one is inside another. Fix `config.json`. |
| `No images in the list. Run Scan first.` | Click **Scan** first. |
| `The original file changed or disappeared since the scan` | Something changed the file. Click **Scan** again. |
| `The vault already holds a different file at ...` | A different file with that name is already in the vault. The app does **not** overwrite it. Move or rename that vault file, then try again. |
| `could not swap the file. Is the image open in another program?` | Close the image in other programs and try again. Your original is untouched. |
| `The file was changed after it was replaced ...` (on Restore) | The app will not overwrite a file you edited later. Your original is still in the vault; copy it back by hand if you want it. |

To start fresh, stop the program and delete `data\state.json` (not the vault).
You can then run Scan again.
