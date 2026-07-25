READ ALOUD USB
==============

1. Open START HERE.html if you are unsure which launcher to use.
2. Windows: double-click START - WINDOWS.exe
3. macOS: double-click START - MACOS.app
4. Linux: run START - LINUX.sh

The first launch loads the Amy voice from the USB and can take several seconds.
After the page says "Amy is ready," paste your draft, place the cursor where
you want to start, and press F8. Amy reads continuously to the end, highlighting
each sentence as it is spoken. Select text first to read only the selection.
Press Esc to stop; F8 resumes from the stopped sentence.

To make an audio file, press "Render / Update," wait for every sentence to
finish, then press "Export WAV." If you edit the draft afterward, pressing
"Render / Update" again re-records only the sentences you changed.

Keep the shared folder beside the launchers. The tool is fully offline at run
time and does not upload text.

macOS first-run note
--------------------
A personal unsigned build may require System Settings > Privacy & Security >
Open Anyway. A signed and notarized release avoids that warning.

Linux first-run note
--------------------
Some file managers open shell scripts as text. In that case, open a terminal in
the USB folder and run:

  bash "START - LINUX.sh"

The Linux script copies only the small launcher to your local cache so it still
works when the USB drive is mounted with non-executable file permissions.
