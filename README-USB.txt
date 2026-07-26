READ ALOUD USB
==============

1. Open START HERE.html if you are unsure which launcher to use.
2. Windows: double-click START - WINDOWS.exe
3. macOS: double-click START - MACOS.app
4. Linux: run START - LINUX.sh

The first launch loads the default voice from the USB and can take several
seconds. After the page says the voice is ready, paste your draft, place the
cursor where you want to start, and press F8. Reading continues to the end,
highlighting
each sentence as it is spoken. Select text first to read only the selection.
Press Esc to stop; a resume marker stays on that sentence (it survives edits
and is saved in sessions), and F8 resumes from there. Press ? in the app for
a keyboard shortcut overlay.

To make an audio file, press "Render / Update," wait for every sentence to
finish, then press "Export WAV." If you edit the draft afterward, pressing
"Render / Update" again re-records only the sentences you changed.

Keep the shared folder beside the launchers. The tool is fully offline at run
time and does not upload text.

Where files go
--------------
Everything you save — sessions, flag reports, exported WAV/MP3, draft text —
is written to a "saves" folder on this drive, next to the app. Nothing is
written to the computer you plug into. If the drive itself cannot be written
(removed or write-protected), the file falls back to that computer's
Downloads folder and the status line tells you so.

Optional Word import: if an "addons/docx" folder exists on this drive, .docx
files can be dropped straight onto the text box. Drives built without the
folder simply do not have the feature; deleting the folder removes it.

Autosave is OFF by default. Turning it on (in Settings & sessions) writes a
rolling session file to this drive once a minute and shows a green indicator
while active.

One honest note: this tool writes nothing to the host computer, but the
computer's own features are outside its control — clipboard history (for
example Win+V on Windows) may retain text you copy or paste, and the
browser's crash recovery may briefly hold page contents.

Windows first-run note
----------------------
Windows SmartScreen may warn about an unsigned app from a USB drive. Click
"More info", then "Run anyway". A signed release avoids that warning.

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
