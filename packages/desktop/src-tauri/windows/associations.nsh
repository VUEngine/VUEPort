; Everything the NSIS installer does that Tauri's own configuration cannot say.
;
; One file, because `installerHooks` takes one path. It is named in
; `tauri.windows.conf.json` and nowhere else: a platform configuration is
; merged over `tauri.conf.json` as a JSON merge patch, so a second
; `installerHooks` in the base would not be added to this one, it would be
; replaced by it — silently, and on the only platform NSIS exists for. Anything
; that has to happen during a Windows install belongs in here.
;
; There are three such things, below: the icon Explorer draws for a Virtual Boy
; file, unzippers offered for `.vbz`, and offering VUEPort for `.zip` without
; taking it.
;
; SHCTX is the install mode's registry root, set by the installer before either
; hook runs: HKLM for a per-machine install, HKCU for a per-user one. Both
; hooks run after Tauri's own registration, so the file classes they name are
; already there.

!define ZIP_PROGID "VUEPort.zip"

!macro NSIS_HOOK_POSTINSTALL
  ; --- What Explorer draws for a Virtual Boy file -------------------------
  ;
  ; Tauri's installer registers the file types and points every one of them at
  ; the application's own icon: the template writes
  ; `"$INSTDIR\${MAINBINARYNAME}.exe,0"` into each type's DefaultIcon, with no
  ; way to say anything else. So the association is right and the picture is
  ; the VUEPort logo three times over.
  ;
  ; These write the DefaultIcon values again, over the ones the installer just
  ; wrote, pointing at the icons that ship in the install directory. Nothing
  ; else about the association is touched — the type, its description and the
  ; open command stay exactly as the installer left them. The key names are the
  ; `name` of each association in `tauri.windows.conf.json`, which is what
  ; Tauri's template uses as the file class.
  ;
  ; A missing icon file is not a failure: Explorer falls back to a generic
  ; document icon, which is where it started.
  WriteRegStr SHCTX "Software\Classes\Virtual Boy ROM\DefaultIcon" "" "$INSTDIR\documents\vb.ico"
  WriteRegStr SHCTX "Software\Classes\Virtual Boy Color ROM\DefaultIcon" "" "$INSTDIR\documents\vbc.ico"
  WriteRegStr SHCTX "Software\Classes\Virtual Boy ROM Archive\DefaultIcon" "" "$INSTDIR\documents\vbz.ico"

  ; --- Unzippers offered for `.vbz` ---------------------------------------
  ;
  ; A `.vbz` is an ordinary zip under a name of its own, and macOS and Linux
  ; are told so (the type conforms to, or is a subclass of, zip) and offer
  ; their unzippers beside VUEPort. Windows has no such hierarchy: an
  ; extension is offered what is registered for that extension and nothing
  ; else. So the archive handlers are listed for it by hand, as values beside
  ; the default, which stays VUEPort's.
  ;
  ; PerceivedType files it with the archives, which is what search and the
  ; shell's verbs for compressed files go by. CompressedFolder is Explorer's
  ; own zip folder view, which reads a zip by its contents rather than its
  ; name. The other two are what 7-Zip and WinRAR register for `.zip`; a
  ; ProgID that does not exist on the machine is simply not listed.
  WriteRegStr SHCTX "Software\Classes\.vbz" "PerceivedType" "compressed"
  WriteRegStr SHCTX "Software\Classes\.vbz\OpenWithProgids" "CompressedFolder" ""
  WriteRegStr SHCTX "Software\Classes\.vbz\OpenWithProgids" "7-Zip.zip" ""
  WriteRegStr SHCTX "Software\Classes\.vbz\OpenWithProgids" "WinRAR.ZIP" ""

  ; --- VUEPort offered for `.zip`, never taking it ------------------------
  ;
  ; Tauri's `fileAssociations` cannot say that on Windows. Its installer
  ; registers every extension the same way it registers `.vb`: it overwrites
  ; the default value of `Software\Classes\.zip`, which is what makes a double
  ; click open the application — and for `.zip` that is the Explorer's own
  ; built-in folder view, which installing an emulator has no business
  ; replacing.
  ;
  ; So `.zip` is left out of the Windows configuration and registered here
  ; instead, the way Windows means a secondary handler to be registered: a
  ; ProgID of our own, listed under the extension's `OpenWithProgids` and under
  ; the executable's own `SupportedTypes` without the extension's default ever
  ; being touched. VUEPort then appears in "Open with" — and becomes the
  ; default only if someone picks it there.

  ; What "Open with -> VUEPort" runs.
  WriteRegStr SHCTX "Software\Classes\${ZIP_PROGID}" "" "Zipped Virtual Boy ROM"
  WriteRegStr SHCTX "Software\Classes\${ZIP_PROGID}\DefaultIcon" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
  WriteRegStr SHCTX "Software\Classes\${ZIP_PROGID}\shell\open" "" "Open with ${PRODUCTNAME}"
  WriteRegStr SHCTX "Software\Classes\${ZIP_PROGID}\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""

  ; Offered for `.zip`. A value beside the key's default, so whatever opens a
  ; zip today goes on opening it.
  WriteRegStr SHCTX "Software\Classes\.zip\OpenWithProgids" "${ZIP_PROGID}" ""

  ; And listed in "Open with -> Choose another app", which asks the executable
  ; what it can open rather than asking the extension who wants it.
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\SupportedTypes" ".zip" ""
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Only what was written above, and only the `.vbz` and `.zip` halves of it.
  ; Nothing here restores a previous handler, because nothing here replaced
  ; one. Tauri's uninstaller resets `.vbz`'s default but leaves the key, so
  ; the values written beside it are removed here.
  ;
  ; The DefaultIcon values need no undoing: Tauri's uninstaller deletes each
  ; file class whole, and they go with it.
  DeleteRegValue SHCTX "Software\Classes\.vbz" "PerceivedType"
  DeleteRegValue SHCTX "Software\Classes\.vbz\OpenWithProgids" "CompressedFolder"
  DeleteRegValue SHCTX "Software\Classes\.vbz\OpenWithProgids" "7-Zip.zip"
  DeleteRegValue SHCTX "Software\Classes\.vbz\OpenWithProgids" "WinRAR.ZIP"
  DeleteRegKey /ifempty SHCTX "Software\Classes\.vbz\OpenWithProgids"
  DeleteRegValue SHCTX "Software\Classes\.zip\OpenWithProgids" "${ZIP_PROGID}"
  DeleteRegKey SHCTX "Software\Classes\${ZIP_PROGID}"
  DeleteRegKey SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe"
!macroend
