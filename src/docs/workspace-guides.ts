import type { DocArticle } from './types';

export const workspaceGuides: DocArticle[] = [
  {
    id: 'saving',
    title: 'Save, recover & reopen',
    description:
      'Keep an editable assembly, recover browser work, and move scenes between devices.',
    group: 'Workspace & files',
    icon: 'save',
    intro:
      'A Kitbasher scene keeps the assembly editable: individual meshes, their placement, and the relationships that make them fit. Save a named .kitbash file for a portable checkpoint, or attach the scene to Google Drive for automatic saves.',
    image: {
      src: './images/scene-workflow.svg',
      alt: 'A workflow diagram showing import, fit, inspect, and saving an editable Kitbasher scene before export.',
      caption:
        'Keep the .kitbash scene as your editable master; export a separate file for the next application.',
    },
    sections: [
      {
        id: 'save-a-scene',
        title: 'Create a portable checkpoint',
        steps: [
          'Give the assembly a recognizable name in the top bar.',
          'Choose Save scene, File → Save, or Ctrl/⌘ + S. Without Drive attached, your browser downloads a self-contained .kitbash file.',
          'Keep that file somewhere you can find again. Use a new name or folder when you want to preserve an earlier stage.',
          'For a scene attached to Drive, use File → Download scene copy to make the same kind of portable backup. Save instead sends pending edits to the existing Drive file.',
        ],
        paragraphs: [
          'A browser download is a new file download; editing the workbench does not silently rewrite a file in your Downloads folder. Drive autosave is the option for repeatedly updating the same cloud scene.',
        ],
      },
      {
        id: 'what-is-saved',
        title: 'What a scene contains',
        bullets: [
          'Geometry, normals, vertex colors, material tints, names, source metadata, and part transforms.',
          'Part visibility, fixed locks, custom pivots, anchor targets, joints, and editable plane constraints.',
          'Editor colors and the scene’s lighting setup, even though those viewing choices are omitted from model exports.',
        ],
        paragraphs: [
          'The binary format packs repeating mesh data and lets pasted copies share one stored mesh. Packing preserves positions, colors, and triangles; it is distinct from decimation. Older .kitbash scene versions can also be opened. Browser preferences, camera preferences, and undo history are not a portable scene history.',
        ],
      },
      {
        id: 'open-a-scene',
        title: 'Resume an assembly',
        steps: [
          'Save or download the current scene if you want to keep it.',
          'Choose File → Open scene or Ctrl/⌘ + O, then select a .kitbash file.',
          'Review the replacement confirmation and choose Open scene.',
          'Check the part list, joins, and scene name before continuing. Opening a local file starts a local scene without the previous Drive association.',
        ],
        note: {
          title: 'Opening replaces; importing adds',
          text: 'Open scene restores an entire saved workbench. Import parts adds model meshes to the existing assembly. Use the operation that matches what you want to retain.',
          tone: 'tip',
        },
      },
      {
        id: 'local-recovery',
        title: 'Understand local recovery',
        paragraphs: [
          'The normal editor saves recovery data to IndexedDB as you work. Reloading the same browser and origin can recover that assembly, including a Drive binding and whether its latest recovered snapshot already reached Drive. Meshes are stored separately so ordinary placement edits do not rewrite every triangle.',
          'Recovery belongs to this browser profile and site address. A different browser, private session, or deployment address has different storage. Clearing site data removes it, and browser storage can fail or run out. Keep downloaded or Drive-saved checkpoints for work you need to retain.',
        ],
        note: {
          title: 'Shared sessions have their own save flow',
          text: 'An MCP live view does not use the normal editor’s local autosave. Save through the shared host or download a scene from the tab before that session ends.',
          tone: 'warning',
        },
      },
      {
        id: 'undo-and-recovery',
        title: 'Undo is for the current editing session',
        paragraphs: [
          'Undo and redo retain the most recent 40 changes. A complete gizmo drag, fit, or mesh-processing apply is one undo step; the scene file is a snapshot rather than a record of every earlier step. Save before an experiment if you may need to return after closing the editor.',
          'If the editor encounters an unexpected error, its recovery screen offers to reload the local save. If the same recovered scene repeatedly fails, it also offers to discard that recovery data. Preserve an independent scene file before discarding when possible.',
        ],
      },
      {
        id: 'large-scenes',
        title: 'Save large scenes deliberately',
        paragraphs: [
          'Scene size is constrained by available device memory and browser capabilities. Private browser windows can reject very large files; use a normal window for large assemblies. A save or upload needs to finish before you close the tab.',
          'Hidden originals from mesh processing remain in the complete scene. This is useful for recovery but increases file size. Export only visible or selected parts when handing off the processed result, and retain the complete master separately.',
        ],
      },
    ],
    related: ['google-drive', 'export', 'performance', 'automation'],
  },
  {
    id: 'google-drive',
    title: 'Google Drive autosave',
    description:
      'Attach an assembly to one Drive file, resume saved scenes, and resolve version conflicts.',
    group: 'Workspace & files',
    icon: 'cloud',
    intro:
      'Connect Google Drive when you want later edits to update the same .kitbash file automatically. Local recovery continues alongside cloud saving, and the header makes the current save state visible.',
    image: {
      src: './images/drive.webp',
      alt: 'The Google Drive dialog on a local installation without Google sign-in configured, offering a scene-copy download.',
      caption:
        'The Drive dialog explains when an installation has not enabled Google sign-in. Local downloads and recovery remain available.',
    },
    sections: [
      {
        id: 'connect',
        title: 'Connect and save the current scene',
        steps: [
          'Click Google Drive in the header, or choose File → Google Drive.',
          'Choose Connect Google Drive and complete Google’s authorization flow.',
          'Choose Save this scene to Drive. Kitbasher creates an ordinary .kitbash file in My Drive.',
          'Keep editing. Later changes update that file; renaming the assembly also renames it in Drive.',
          'Wait for Saved to Drive before closing the tab. Choose View in Drive to open the file’s Drive page.',
        ],
        paragraphs: [
          'Drive is optional. If the installation has no Google sign-in configuration, local editing, recovery, downloads, and export still work. Installation owners can use the repository’s Google Drive setup guide to enable their deployment.',
        ],
      },
      {
        id: 'save-states',
        title: 'Read the save state',
        table: {
          headers: ['Header state', 'What to do'],
          rows: [
            [
              'Waiting to save / Saving to Drive',
              'Keep the tab open while edits are grouped or the full scene uploads.',
            ],
            ['Saved to Drive', 'The latest edited revision has finished uploading.'],
            [
              'Drive offline',
              'Continue with local recovery; reconnect and wait for the cloud save.',
            ],
            ['Reconnect Drive', 'Open Drive and reconnect when Google requires authorization.'],
            [
              'Drive save failed',
              'Read the message and use Retry saving or download a scene copy.',
            ],
            [
              'Drive file changed',
              'Saving is paused until you choose how to resolve the versions.',
            ],
          ],
        },
        paragraphs: [
          'Camera and selection changes do not trigger uploads. Autosave groups edits and sends the complete binary scene, rather than streaming only changed triangles. Large assemblies can take longer and use more bandwidth. Ctrl/⌘ + S asks the attached scene to finish its pending cloud save.',
        ],
      },
      {
        id: 'reopen',
        title: 'Open an existing Drive scene',
        steps: [
          'Open the Google Drive dialog and connect if needed.',
          'Find the assembly in Your Drive scenes. Use Refresh or Load more scenes when appropriate.',
          'Select the scene, review the replacement notice, and confirm Open scene.',
          'Resume editing; autosave now updates that selected Drive file.',
        ],
        paragraphs: [
          'The list contains scenes saved by Kitbasher. A .kitbash file uploaded to Drive by another route may not appear here: download and open it locally, then save it to Drive through Kitbasher.',
        ],
      },
      {
        id: 'conflicts',
        title: 'Choose between conflicting versions',
        paragraphs: [
          'When the cloud file has different scene contents, Kitbasher keeps the local scene and pauses saving. It does not merge simultaneous edits made through separate Drive editors. Download scene copy first if you want an independent copy of the local work.',
        ],
        bullets: [
          'Load Drive version replaces the current workbench with the cloud scene. Confirm with Discard local edits and load.',
          'Overwrite Drive version sends your local scene over the shown cloud version. Confirm with Confirm overwrite. A newer remote change requires another decision.',
          'Save a new Drive copy preserves your local version in a separate cloud file.',
          'Check again retries the content check. Cancel leaves the current scene as it is.',
        ],
        note: {
          title: 'Use one editor per Drive file',
          text: 'The overwrite check is a version check, not a simultaneous-editing lock. Use the shared headset or MCP session when you want coordinated editing of one scene.',
          tone: 'warning',
        },
      },
      {
        id: 'offline-and-reauthorization',
        title: 'Work through interruptions',
        paragraphs: [
          'Local recovery continues while offline. Transient upload errors retry, and returning online prompts another save attempt. A restored local scene retains its cloud association, so reconnecting can continue saving to the same file.',
          'Some installations can renew Google sessions automatically; others need a click after the access token expires. Autosave does not launch a sign-in popup by itself. Reconnect through the dialog, then verify Saved to Drive. Portable .kitbash downloads carry neither Google credentials nor Drive bindings.',
        ],
      },
      {
        id: 'disconnect',
        title: 'Detach, duplicate, or disconnect',
        paragraphs: [
          'Use Stop autosave to detach this assembly from its Drive file. Disconnect also clears this tab’s connection and any hosted session cookie. Neither action deletes your Drive file or revokes connections on other devices.',
          'Save a new Drive copy creates a separate destination for a variant. Download scene copy creates a portable local checkpoint. Opening a local scene or starting a new assembly clears the old cloud association; save pending work before replacing it.',
        ],
      },
    ],
    related: ['saving', 'troubleshooting', 'headset'],
  },
  {
    id: 'export',
    title: 'Export & hand off',
    description: 'Choose the right model format for printing, Blender, and future editing.',
    group: 'Inspect & finish',
    icon: 'download',
    intro:
      'Export the parts you need in the format the next application expects. Keep an editable .kitbash master as well: a print mesh and a complete assembly preserve different information.',
    image: {
      src: './images/export.webp',
      alt: 'Export dialog showing GLB, Blender with joints, 3MF, STL, and Kitbasher scene options.',
      caption:
        'The export summary shows the included part count and dimensions before downloading.',
    },
    sections: [
      {
        id: 'choose-a-format',
        title: 'Choose a format by what you need to preserve',
        table: {
          headers: ['Format', 'Preserves', 'Use it for'],
          rows: [
            [
              'Kitbasher scene · .kitbash',
              'Editable parts, geometry, relationships, editor colors, and lighting.',
              'Continuing work or making a full assembly checkpoint.',
            ],
            [
              'Blender / glTF · .glb',
              'Separate named meshes, material colors, and transforms.',
              'Blender import or a general 3D handoff.',
            ],
            [
              'Blender with joints · .zip',
              'GLB and a script that rebuilds joint anchors and rotation locks.',
              'Posing the connected assembly in Blender.',
            ],
            [
              'Multipart model · .3mf',
              'Separate mesh objects and placement in millimeters.',
              'A multipart printing workflow; this exporter omits colors and joints.',
            ],
            [
              'Print-ready geometry · .stl',
              'One binary file containing the chosen triangles.',
              'A triangle-only printing handoff; no colors, names, or joints.',
            ],
          ],
        },
      },
      {
        id: 'export-steps',
        title: 'Download an export',
        steps: [
          'Choose Export or Ctrl/⌘ + Shift + E.',
          'Select the file format and edit File name.',
          'Set Include to All parts, Visible parts, or Selected parts.',
          'Review the part count and dimensions in millimeters.',
          'Choose Export assembly and wait for the browser download.',
          'Open the result in the receiving application and verify scale, orientation, and the intended part count.',
        ],
        paragraphs: [
          'All parts includes hidden originals. Visible parts uses saved part visibility; temporary alignment and isolation views do not redefine the scene’s exported parts. Relationships survive a subset export only when both related parts are included.',
        ],
      },
      {
        id: 'units-and-appearance',
        title: 'Check units and appearance',
        paragraphs: [
          'Kitbasher works in millimeters with Y up. GLB uses meters according to glTF, with real-world size preserved. STL is written in millimeters and converted to Z up; 3MF carries millimeter units.',
          'Formats that support color use material tint and available vertex colors. Editor colors, the Distinct display palette, and editor lighting do not change exported material colors. Texture maps, animation, rigging, and advanced glTF compression are outside the retained feature set.',
        ],
      },
      {
        id: 'blender-package',
        title: 'Continue with joints in Blender',
        steps: [
          'Choose Blender with joints and export the ZIP.',
          'Extract the package, keeping the GLB and import_assembly.py together.',
          'Open the included script in Blender’s Scripting workspace and run it.',
          'The script creates an assembly scene and saves assembly.blend beside the script.',
          'Select a named joint empty to pose its connected child around the exported anchor.',
        ],
        paragraphs: [
          'Plain GLB import retains meshes and materials; the package reconstructs the joint controls. Keep connected off exports the joint’s metadata without constraint parenting. Plane constraints are retained as metadata and solved placement, while their live solver remains in Kitbasher. The package targets Blender 4.x and 5.x.',
        ],
      },
      {
        id: 'combine-vs-union',
        title: 'Decide whether parts need merging',
        paragraphs: [
          'Combine meshes puts original triangles in one mesh object. It is fast and preserves the source surfaces, including internal overlaps. Boolean union calculates an outer combined solid and needs suitable closed, consistently oriented input geometry.',
          'An STL export does not automatically union intersecting parts or repair holes. Use Boolean union first when you need a continuous union, then inspect the result. Failed Boolean preparation leaves the original scene intact, and active merge jobs can be cancelled.',
        ],
        note: {
          title: 'Review the print in your slicer',
          text: 'The “Print-ready geometry” format label describes the STL handoff. It does not certify watertightness, wall thickness, supportability, or a successful physical print.',
          tone: 'warning',
        },
      },
      {
        id: 'dense-exports',
        title: 'Handle dense assemblies',
        paragraphs: [
          '3MF is XML-based and can exceed browser string limits on dense scenes. GLB also has a mesh-data size limit. If an export reports that it is too large, try STL or .kitbash, reduce the included subset, or deliberately process a copy of the mesh.',
          'Display → Scan detail only changes viewport drawing and cannot shrink exported geometry. Decimation and remeshing do change the mesh; preserve originals and verify important mating details before exporting a reduced copy.',
        ],
      },
    ],
    related: ['saving', 'performance', 'display', 'joints'],
  },
  {
    id: 'display',
    title: 'Views, colors & lighting',
    description:
      'Read shapes clearly, distinguish parts, and light an assembly without changing its exported appearance.',
    group: 'Workspace & files',
    icon: 'palette',
    intro:
      'A useful view makes a tight fit easier to judge. Switch projection, reveal separate parts, and tune the lighting to inspect geometry. Editor colors and lights are saved with the scene but do not alter the colors of exported models.',
    image: {
      src: './images/display.webp',
      alt: 'Display menu offering scan detail, Material, Editor and Distinct colors, and lighting presets.',
      caption: 'Display settings bring geometry and part boundaries into focus while you work.',
    },
    sections: [
      {
        id: 'projection',
        title: 'Use a view that answers the question',
        paragraphs: [
          'Use the viewport’s camera controls to orbit, pan, zoom, and frame the assembly. Front, Right, and Top views help compare axes; their default shortcuts are 1, 3, and 7. Press 5 to switch between perspective and orthographic projection.',
          'Perspective is useful for depth and overall shape. Orthographic removes perspective size differences, helping you compare a silhouette or alignment across a flat view. F frames the selection, Home frames the full assembly, and . centers the orbit on the selection without changing zoom or direction.',
        ],
      },
      {
        id: 'part-colors',
        title: 'Separate material color from editor color',
        table: {
          headers: ['Display mode', 'What you see'],
          rows: [
            [
              'Material',
              'Material tints and vertex colors that the supported model formats export.',
            ],
            [
              'Editor',
              'An assigned editor color, or material colors where no editor color is set.',
            ],
            [
              'Distinct',
              'Different colors by part-list order, with assigned editor colors taking priority.',
            ],
          ],
        },
        paragraphs: [
          'Select one or more parts and use Appearance → Editor color to label their role in the assembly. Material tint changes their exported color instead. Clear an editor color with its × control, or choose Clear all editor colors from Display. An editor color replaces vertex colors in the view.',
          'Editor colors are undoable scene data. The selected Material, Editor, or Distinct mode is a browser view preference. Distinct colors can change after you delete or merge a part because they follow part-list order.',
        ],
      },
      {
        id: 'lighting-presets',
        title: 'Start with a lighting preset',
        bullets: [
          'Studio provides the default warm key, cool rim, and fill.',
          'Soft gives more even light for judging colors.',
          'Headlight lights what the camera faces, useful when inspecting a shaded join.',
          'Dramatic emphasizes shape with stronger side lighting.',
        ],
        paragraphs: [
          'Open Display beside Interference and choose a preset. Adjust Brightness there, or use Edit lights… to open the full lighting panel. View → Lighting… opens the same panel. A changed preset reads Custom until its values match a preset again.',
        ],
      },
      {
        id: 'custom-lights',
        title: 'Position and tune individual lights',
        image: {
          src: './images/lighting.webp',
          alt: 'Lighting panel with scene brightness, fill settings, and editable directional and point lights.',
          caption:
            'Use broad fill for legibility, then adjust a light to reveal a particular seam.',
        },
        paragraphs: [
          'The panel controls Brightness, Ambient, Sky fill, sky and ground colors, and Shadows. Add up to eight directional or point lights. Each light has an enabled state, name, color, and intensity.',
          'Directional lights use Azimuth and Elevation. Point lights use an X/Y/Z position in millimeters and a Range; 0 reaches everything. Follow camera makes a light move with the view. Only directional lights that do not follow the camera cast shadows; point lights do not.',
        ],
        bullets: [
          'Click a non-camera light’s viewport handle to edit it without changing part selection.',
          'With Select active, drag the light arrows; snapping and Shift fine adjustment apply.',
          'Use Reset to default to restore your browser’s default lighting, Use as default to save a new default, or Restore built-in default for Studio.',
        ],
      },
      {
        id: 'exploded-and-wireframe',
        title: 'Expose hidden structure',
        paragraphs: [
          'Use the Exploded view slider to visually separate an assembly and understand which part belongs where. Reset the slider before reviewing actual contact or making assembly edits. Exploded positions are a viewing aid rather than new fitted placements.',
          'Wireframe reveals triangle structure. Grid and joint visibility can be toggled from View, while isolation and alignment visibility reduce surrounding clutter. Interference inspection uses its own neutral display to make contacts and overlaps readable.',
        ],
      },
      {
        id: 'scan-detail',
        title: 'Balance drawing detail and responsiveness',
        paragraphs: [
          'Display → Scan detail offers Automatic, Full, and Fast. Automatic draws lighter meshes during movement and returns to originals at rest on desktop. Full always draws source geometry; Fast keeps prepared lightweight meshes visible.',
          'Surface tools, picking, No clip, fitting, save, and export use original geometry. A faster view therefore helps navigation without silently modifying the assembly. Geometry reduction is a separate, explicit mesh-processing operation.',
        ],
      },
    ],
    related: ['preferences', 'performance', 'measurement', 'export'],
  },
  {
    id: 'preferences',
    title: 'Preferences & shortcuts',
    description:
      'Tune navigation, marker readability, keyboard bindings, and headset input for your setup.',
    group: 'Workspace & files',
    icon: 'settings',
    intro:
      'Preferences stay with this browser and apply to every scene. The panel leaves the workbench usable, so you can try a navigation or marker setting immediately and adjust it without interrupting the assembly.',
    image: {
      src: './images/preferences.webp',
      alt: 'Preferences side panel with Navigation, Markers, Keyboard, and Headset tabs.',
      caption: 'Tune the controls to your mouse, trackpad, screen, and preferred shortcuts.',
    },
    sections: [
      {
        id: 'open-preferences',
        title: 'Open and navigate preferences',
        steps: [
          'Click the top-bar gear, choose File → Preferences…, or press Ctrl/⌘ + ,.',
          'Choose Navigation, Markers, Keyboard, or Headset.',
          'Change a setting and try it in the viewport. Settings save in this browser and sync between its open tabs.',
          'Use a section’s Reset control to restore its defaults, or close the panel when finished.',
        ],
        paragraphs: [
          'A scene file does not carry these preferences to another device. Keep that distinction in mind when a saved assembly feels different on another browser. Keyboard-focused tabs support arrow keys; Escape closes the panel when it is not being used to cancel a field edit.',
        ],
      },
      {
        id: 'scroll-zoom',
        title: 'Make wheel and trackpad zoom comfortable',
        bullets: [
          'Sensitivity changes the amount of zoom for each scroll step.',
          'Response curve below 1 makes small and large wheel steps more even; 1 follows scroll distance directly; above 1 accelerates fast scrolling.',
          'Smoothing changes how long the wheel glides toward a step, and can be turned off.',
          'Invert changes wheel direction. Trackpad pinch continues to follow your fingers.',
        ],
        paragraphs: [
          'The response chart previews a wheel notch and a fine step. Tune sensitivity first, then curve and smoothing. A small macOS wheel event can feel too weak with a linear curve even when fast scrolling feels strong, so try a lower curve before making every step much larger.',
        ],
      },
      {
        id: 'orbit-and-transform',
        title: 'Choose orbit and transform behavior',
        paragraphs: [
          'Orbit around selection uses the selection’s visible center or a part’s custom pivot whenever you orbit. It is the same preference exposed in the Camera panel and through Shift + .. Panning remains free; the next orbit rotates around the selection without snapping the panned view back.',
          'Transform tool → Enable scaling controls whether the combined Transform gizmo shows scale handles. Turn it off for placement work where accidental resizing would be costly. The dedicated Scale tool and numeric scale fields remain available. Snapping and World/Local axes are workbench controls rather than a reason to change this preference.',
        ],
      },
      {
        id: 'markers',
        title: 'Make points and labels readable',
        paragraphs: [
          'Markers shares one screen-pixel size across anchors, custom pivots, picked points, measurements, joints, and painted patches. The marker stays the same visible size while you zoom the model.',
          'Labels can sit beside their point or use CAD-style callouts with leader lines. Callouts stay above the point on screen and can use a clearance from the model outline or a fixed leader length. Overlapping labels stack outward. Increase these settings for dense joins or smaller screens, then check that labels do not hide the surface you need to pick.',
        ],
      },
      {
        id: 'keyboard',
        title: 'Remap an action or add an alternative',
        steps: [
          'Open Keyboard and find the desired tool, camera, editing, or file action.',
          'Record a key for that action, or add a second binding.',
          'If the key belongs to another action, read the reassignment message: one key belongs to one action at a time.',
          'Remove a binding or reset it when needed. Tooltips, menus, and help show the current mappings.',
        ],
        paragraphs: [
          'Bindings use the physical key when a keyboard layout or Alt changes its typed character. Standard text-field copy, cut, paste, selection, and undo keep their native behavior; Save and Open also work from a field. Press F1 or ? for the workbench help with your current shortcuts.',
        ],
      },
      {
        id: 'headset-bindings',
        title: 'Configure headset input',
        paragraphs: [
          'Headset preferences expose main hand, face-button and stick-click actions, stick modes, deadzone, and world navigation settings. The immersive panel’s Bindings page provides the corresponding controls. Trigger/pinch and grip retain their fixed interaction roles.',
          'Main-hand selection moves the tool palette to the opposite hand. Reset bindings restores the defaults. These settings belong to the browser where you change them, so configure the headset browser as well when using a shared session.',
        ],
      },
    ],
    related: ['display', 'transforms', 'headset', 'measurement'],
  },
  {
    id: 'performance',
    title: 'Dense scans & background work',
    description:
      'Keep large assemblies responsive and understand when mesh processing changes geometry.',
    group: 'Inspect & finish',
    icon: 'zap',
    intro:
      'Kitbasher separates lighter drawing from deliberate geometry changes. Try display optimization first when navigation is slow. Use decimation or remeshing only when you intend to create a different mesh, and preserve a source copy for precision assembly.',
    image: {
      src: './images/mesh-processing.webp',
      alt: 'Decimate or remesh dialog with triangle target, error limit, border preservation, and keep-original options.',
      caption:
        'Mesh processing is explicit and reviewable; a lightweight display mesh is automatic and display-only.',
    },
    sections: [
      {
        id: 'display-only',
        title: 'Start with scan detail',
        paragraphs: [
          'Display → Scan detail defaults to Automatic. Dense parts receive a lightweight display mesh in a background worker. Automatic uses it while moving the camera or parts and during immersive sessions; the desktop returns to original detail at rest. Fast keeps lightweight display meshes visible, while Full disables them.',
          'These are display proxies. Picking, contact fitting, anchors, No clip, saved scenes, and exports keep using original geometry. Desktop surface tools, wireframe, and interference inspection draw full detail. The originals stay visible while proxies are being prepared or when a proxy cannot be built.',
        ],
      },
      {
        id: 'reduce-triangles',
        title: 'Prepare a decimated copy',
        steps: [
          'Select one unlocked part.',
          'In the inspector, choose Mesh details → Decimate or remesh….',
          'Choose Decimate and set Triangles to keep (%).',
          'Set the Approximate error limit as a percentage of mesh size. Keep Preserve open borders on when those edges matter.',
          'Leave Keep original as a hidden part enabled, then choose Prepare mesh.',
          'Read the achieved triangle count and error estimate, choose Add processed copy, and inspect the result in the viewport. Undo restores the previous scene.',
        ],
        paragraphs: [
          'Borders and fine features can prevent reaching the target percentage. Vertex colors are retained, but the error estimate does not guarantee an unchanged mating interface. Compare the processed join against the original before using it for a precision fit.',
        ],
      },
      {
        id: 'voxel-remesh',
        title: 'Understand voxel remeshing',
        paragraphs: [
          'Voxel remesh rebuilds a closed mesh on a voxel grid. Resolution ranges from 24 to 128; a higher value preserves smaller details at greater memory cost. This operation requires suitable closed geometry.',
          'Remeshing changes mating surfaces, can remove thin features, and removes vertex colors while retaining material tint. Use it for a deliberate new surface rather than a lossless file-size reduction. Prepare the mesh first, then apply and review; no geometry is changed merely by opening the dialog.',
        ],
        note: {
          title: 'Keep the original',
          text: 'Parts with anchors, joints, or plane constraints always create independent processed copies. Their assembly links stay on the hidden original. Exports scoped to all parts include those originals too.',
          tone: 'warning',
        },
      },
      {
        id: 'cancel-and-progress',
        title: 'Follow and cancel background jobs',
        paragraphs: [
          'Background activity in the header lists queued and running work, including surface indexing, viewport optimization, mesh processing, interference inspection, merges, and Drive uploads. Each job names its stage and shows elapsed time; measured percentages describe that stage. An indeterminate bar means that stage has no meaningful percentage.',
          'Use Cancel for jobs that offer it. Mesh processing also has Cancel processing in its dialog. Cancellation stops pending work rather than applying a half-finished result. Keep the panel open for long jobs or return to it while working elsewhere.',
        ],
      },
      {
        id: 'notification-history',
        title: 'Revisit completion messages and errors',
        paragraphs: [
          'The Notifications bell keeps messages after their banners close. Errors stay visible until dismissed. You can mark messages read, remove individual messages, or clear history.',
          'Routine mesh preparation and successful Drive autosaves finish quietly; failures still alert you. History is kept for this tab’s current session, with the latest 50 finished jobs and 100 notifications. Download scene checkpoints separately when you need a durable record of the work itself.',
        ],
      },
      {
        id: 'large-file-limits',
        title: 'Choose workable formats and subsets',
        paragraphs: [
          'All open meshes still occupy device memory and GPU resources. There is no fixed overall import size limit, but individual GPU buffers and text formats impose limits. STL and OBJ are read incrementally; embedded GLTF and the model text in 3MF face browser text limits.',
          'Contact painting and Boolean union are limited to 10 million triangles per part in the app. Very dense interference reports can be partial. GLB and 3MF exports have additional format limits; use STL or .kitbash, or export a subset, when the export dialog explains that a scene is too large. Display optimization does not reduce these source-geometry limits.',
        ],
      },
    ],
    related: ['display', 'export', 'saving', 'troubleshooting'],
  },
  {
    id: 'headset',
    title: 'Assemble in a headset',
    description:
      'Share an assembly with the desktop and use immersive tools, hand placement, and world navigation.',
    group: 'Beyond the desktop',
    icon: 'headset',
    intro:
      'Use the computer for file operations and detailed inspector work, then place and inspect parts by hand in an immersive WebXR view. The local headset companion shares one scene between the desktop and headset, with separate cameras and undo histories.',
    image: {
      src: './images/headset.webp',
      alt: 'Kitbasher Headset preferences showing controller bindings and world navigation settings.',
      caption:
        'Preferences → Headset configures controller actions and world navigation. Import, save, and export from the desktop.',
    },
    sections: [
      {
        id: 'start-a-session',
        title: 'Start a local shared scene',
        code: {
          language: 'shell',
          value:
            'npm run headset\n# Or open an existing scene:\nnpm run headset -- path/to/scene.kitbash',
        },
        steps: [
          'Run the command from a local Kitbasher checkout with its dependencies installed. It builds the app and opens the desktop scene.',
          'Keep the terminal running. Copy the printed HTTPS address and six-digit code, also available under Headset on desktop.',
          'On a headset on the same network, open the address in its browser and enter the code. The companion uses a local self-signed certificate, so the browser may ask you to continue through its connection warning.',
          'Choose Headset → In your room or Virtual space when supported by that browser and device.',
          'Import and save on the computer. Save the assembly before ending the companion with Ctrl + C.',
        ],
        note: {
          title: 'The session is temporary',
          text: 'Nothing is kept on the headset. Anyone on the network with the code can edit while the shared session is running; keep it for the people joining your assembly.',
          tone: 'warning',
        },
      },
      {
        id: 'part-and-world',
        title: 'Move parts and navigate the world',
        paragraphs: [
          'With Grab, Move, Rotate, or Scale active, press the trigger on a part to hold it and release to place it. The grab follows your hand and wrist around the point you took. Joints, fixed locks, retained plane constraints, and No clip still apply.',
          'Grip holds the world instead. Use both hands to carry, turn, and resize the view; moving them apart makes the model appear larger without changing its actual dimensions. Keep level behaves like an upright turntable; turn it off to look underneath. With one controller, grip plus thumbstick zooms or performs a stepped turn.',
          'The View panel offers Frame visible, Focus selection, Previous view, 1:1, zoom, and turns. Previous view restores a navigation state independently of scene undo. Tracking or session-focus loss ends the current gesture; release and press again to resume.',
        ],
      },
      {
        id: 'wrist-and-tools',
        title: 'Use the wrist palette and active-tool panel',
        bullets: [
          'The off-hand wrist palette selects Grab, Move, Rotate, Scale, Align / paint, Joint, Measure, and Anchors.',
          'The Active tool page shows the moving/target stage, fit controls, and axis choices.',
          'For point alignment, trigger picks source and target; Apply fit commits a ready fit. Painted contact fitting still needs three complete patch pairs; flush seams and plane relationships need one.',
          'Multi-select lets trigger clicks add or remove selections. Precision slows grabs and stick adjustments to 10%.',
        ],
        paragraphs: [
          'Aim at a panel control and pull the trigger. Move the panel by its background, or use the bring-panel-here binding. Gripping to navigate ends an active grab or paint stroke without clearing alignment picks.',
        ],
      },
      {
        id: 'default-controls',
        title: 'Learn the default controller bindings',
        table: {
          headers: ['Control', 'Kitbasher default'],
          rows: [
            ['A / B', 'Advance or confirm / step back.'],
            ['X / Y', 'Undo, including a paint stroke / toggle wrist tools.'],
            ['Left / right stick click', 'Bring panel here / toggle precision.'],
            ['Left stick', 'Move selection horizontally and along the chosen vertical axis.'],
            [
              'Right stick',
              'Adjust the active tool: rotation, movement, scale, brush radius, or fit offset.',
            ],
          ],
        },
        paragraphs: [
          'Use Axis to cycle X/Y/Z. Bindings can be changed from the immersive Bindings page or Preferences → Headset. Main hand moves the palette to the other hand; trigger/pinch and grip keep their fixed roles. Hand-tracking pinch acts as the trigger when available.',
        ],
      },
      {
        id: 'sharing-and-saving',
        title: 'Understand shared edits and saves',
        paragraphs: [
          'The desktop and headset edit the same scene. Cameras, selections, active tools, and navigation stay local. Changes merge by part and property; undo on one side reverts that side’s own changes. Save and export from desktop before closing the companion.',
          'A normally hosted HTTPS copy can offer immersive mode without the companion, but it then uses that headset browser’s own scene and does not share with your desktop. The agent MCP live view is also a different session and is never offered directly to the network.',
        ],
      },
      {
        id: 'limits',
        title: 'Plan around immersive limits',
        paragraphs: [
          'File import/save, merging, mesh processing, typed numeric entry, colors, lighting, and reference-plane selection remain desktop operations. Automatic scan detail uses lighter display meshes, while original geometry remains authoritative for picks and fits.',
          'Dense scenes can exceed a headset’s drawing budget. Use the panel’s frame-rate and triangle readout, and consider a deliberately reduced copy when needed. The project’s automated headset checks use an emulator; physical-device frame rate, comfort, and dense-scan interaction still require checking on the actual headset.',
        ],
      },
    ],
    related: ['preferences', 'performance', 'saving', 'automation'],
  },
  {
    id: 'automation',
    title: 'Build with an agent',
    description:
      'Connect the local MCP server, create and fit geometry, and edit alongside an agent.',
    group: 'Beyond the desktop',
    icon: 'terminal',
    intro:
      'The included Model Context Protocol server lets a coding agent create, inspect, assemble, and export models using Kitbasher’s scene store and solvers. It runs locally without a browser or GPU, and saves ordinary .kitbash files you can continue editing.',
    image: {
      src: './images/workbench.webp',
      alt: 'Kitbasher workbench showing separate editable parts, the viewport, and the inspector.',
      caption:
        'An agent’s live view uses the same workbench and preserves your own camera and selection.',
    },
    sections: [
      {
        id: 'install',
        title: 'Build and register the local server',
        code: {
          language: 'shell',
          value:
            'npm install\nnpm run build\n\n# Codex, using your installation’s absolute path:\ncodex mcp add kitbasher -- node /absolute/path/to/kitbasher/dist-mcp/kitbasher-mcp.js\n\n# Claude Code:\nclaude mcp add --scope user kitbasher -- node /absolute/path/to/kitbasher/dist-mcp/kitbasher-mcp.js',
        },
        paragraphs: [
          'Use Node.js 22.12 or newer. From the repository, install dependencies and run the build. Rebuild after updating Kitbasher. Keep kitbasher-mcp.js and its background kitbasher-compute.js bundle together.',
          'Other stdio MCP clients use command node and the absolute server file path as its argument. Follow the client’s own permission controls. The server runs locally; your agent client may send tool results, including rendered images and model data, to its model provider.',
        ],
      },
      {
        id: 'request-a-result',
        title: 'Ask for an observable result',
        paragraphs: [
          'A useful request names the shape, units, relationships, and saved output: “Build a desk lamp with a weighted base, two jointed arms, and a conical shade. Check that it is connected and save it as lamp.kitbash.” For scanned parts, supply the model paths and explain which surfaces should mate.',
          'The server uses millimeters, Y up, right-handed coordinates, and XYZ Euler degrees. Ask the agent to inspect bounds and render several views, then save to a named file. A successful tool call or attractive image does not itself create a durable scene file.',
        ],
      },
      {
        id: 'tool-families',
        title: 'What the agent can do',
        table: {
          headers: ['Task', 'Tools'],
          rows: [
            [
              'Create and organize',
              'new_scene, add_parts, import_model, update_parts, duplicate_parts, delete_parts',
            ],
            [
              'Fit and connect',
              'place_parts, align_parts, fit_surfaces, fit_anchors, create_joint, update_joint, create_plane_constraint, update_plane_constraint, remove_relationships, set_clipping',
            ],
            ['Check and see', 'get_scene, raycast, inspect_interference, render_view'],
            ['Process and retain', 'merge_parts, undo, redo, open_scene, save_scene, export_scene'],
            ['Work together', 'open_live_view'],
          ],
        },
        paragraphs: [
          'Procedural shapes include boxes, cylinders, cones, spheres, capsules, tori, lathes, extrusions, tubes, lofts, and raw meshes. Array and mirror duplication share mesh data. Surface fitting supports contact, flush seams, and plane relationships for scans. The MCP merge_parts tool also offers Boolean subtraction and intersection in addition to combine and union; the desktop Merge dialog exposes combine and union.',
        ],
      },
      {
        id: 'live-view',
        title: 'Join the agent’s live scene',
        paragraphs: [
          'Ask the agent to call open_live_view. It opens a local, tokenized browser address for that server’s scene. Your ordinary app tab is a separate scene; save its assembly and ask the agent to open the file before sharing it.',
          'Each live tab has its own camera, selection, tools, picks, paint, and inspection view. Scene edits combine by part and property; later conflicting values win, then relationships are solved again. Your undo reverts your own changes, preserving values another participant changed afterward.',
          'The live view has no normal local autosave. The scene lives in the agent’s server, so ask it to save or use Save scene in the tab. If the server ends, an open tab retains its own copy and can download it.',
        ],
      },
      {
        id: 'fitting-and-limits',
        title: 'Read constraints and limitations',
        paragraphs: [
          'A constrained result means locks, joints, or plane constraints prevented the requested pose. Server clipping starts off because procedural parts may intentionally overlap; ask for set_clipping when movement should avoid them. Every mutating call is one undo step and either applies completely or leaves the scene unchanged.',
          'The CPU render provides orthographic inspection views, axes, and a scale bar, rather than the app’s materials and lighting. The MCP documentation lists a lower Boolean budget than the desktop app, so divide dense operations or use the app when required.',
        ],
      },
      {
        id: 'file-lifetime',
        title: 'Keep files and sessions explicit',
        paragraphs: [
          'Each server owns one in-memory scene. Separate agent sessions do not automatically share it. new_scene and open_scene guard unsaved work, and save/export tools require an explicit overwrite option before replacing an existing file.',
          'File tools read model and scene files and write supported scene, model, package, and image formats. Relative paths start from the folder where the client launched the server. Give an absolute save path when the result needs to be easy to locate.',
        ],
      },
    ],
    related: ['saving', 'headset', 'alignment', 'export'],
  },
  {
    id: 'troubleshooting',
    title: 'Troubleshooting & limitations',
    description:
      'Find the cause of missing parts, failed fits, save interruptions, and dense-mesh problems.',
    group: 'Start here',
    icon: 'help',
    intro:
      'Start with the exact message, current tool, and scene state. Many apparent failures are a hidden part, an active constraint, a viewing mode, or a format limitation. Keep a scene copy before changing geometry or replacing work.',
    image: {
      src: './images/workbench.webp',
      alt: 'The workbench with the Parts panel and Properties inspector visible around the model.',
      caption:
        'Use the part list, inspector, and persistent notifications to narrow down a problem.',
    },
    sections: [
      {
        id: 'missing-model',
        title: 'A part is missing or seems far away',
        steps: [
          'Search for it in the Parts panel and select it there.',
          'Check its visibility, any active isolation or alignment view, and the Exploded view slider.',
          'Press F to frame the selection or Home to frame everything.',
          'Check the imported scale and up axis. A meters-versus-millimeters mismatch makes a model appear dramatically too large or small.',
          'If a dense mesh draws but cannot be clicked yet, select it from the part list while surface indexing finishes.',
        ],
        paragraphs: [
          'An empty or failed canvas can also indicate unavailable WebGL or GPU resources. Try a current WebGL-capable browser, check that browser graphics acceleration is available, and reduce the open scene if memory is exhausted.',
        ],
      },
      {
        id: 'imports-and-appearance',
        title: 'An import looks wrong',
        paragraphs: [
          'Automatic import uses meters and Y up for glTF, millimeters and Z up for STL/OBJ, and declared 3MF units with Z up. Override source units or up axis when the source application used another convention.',
          'Kitbasher retains geometry, material tint, and vertex colors, but not texture maps, animation, or rigging. Use a self-contained GLB rather than a GLTF that depends on external resources. A mesh with reversed normals can appear inside-out because back faces are hidden.',
          'If a surface is too dark to inspect, try Soft or Headlight lighting and check Brightness. Switch Display to Material when you need to see exported colors rather than editor labels.',
        ],
      },
      {
        id: 'part-will-not-move',
        title: 'A part will not reach the requested position',
        bullets: [
          'Check the fixed lock and whether another selected part is locked.',
          'Check joints and their rotation locks; connected parts move around their joint anchor.',
          'Check retained plane constraints and their residuals. They can restrict movement or conflict with a requested fit.',
          'Check No clip and Allowed overlap. Another visible surface can stop movement or a fit.',
          'Reset an exploded view and leave a camera tool when you intend to edit parts.',
        ],
        paragraphs: [
          'A rigid fit never stretches geometry to satisfy incompatible targets. Spread point or patch pairs around a join, finish every pair, and inspect RMS and individual residuals. A small aggregate error does not prove every visible seam is acceptable.',
        ],
      },
      {
        id: 'paint-and-booleans',
        title: 'Painting or a Boolean operation fails',
        paragraphs: [
          'Contact painting marks whole triangles and follows connected edges. Disconnected surfaces need separate patch pairs; coarse triangles limit brush precision. Contact fitting needs at least three complete pairs. A pending source or unfinished target prevents applying the fit.',
          'Boolean union expects closed, consistently oriented meshes without self-intersections; it is not a scan-repair tool. A combined mesh still contains all original triangles and overlaps. App contact paint and Boolean operations have a per-part triangle limit. Read the operation’s message rather than repeatedly applying the same failing inputs.',
        ],
      },
      {
        id: 'saving',
        title: 'A save is pending or Drive reports a conflict',
        paragraphs: [
          'Download a scene copy when you need a portable checkpoint while investigating a cloud problem. Open Drive to read the error, reconnect, or Retry saving. Wait for Saved to Drive before closing; local recovery and a completed cloud upload are separate states.',
          'For Drive file changed, choose Load Drive version, Overwrite Drive version, Save a new Drive copy, or Check again. Loading and overwriting ask for a second confirmation. Use one editor per Drive file because these versions are not merged automatically.',
          'Recovery is tied to this browser profile and origin. Clearing site storage removes it. Private windows can fail to hold very large scene files; use a normal window and keep independent downloaded or cloud-saved backups.',
        ],
      },
      {
        id: 'slow-or-large',
        title: 'A dense assembly is slow or will not export',
        paragraphs: [
          'Try Automatic or Fast scan detail first. Watch Background activity while proxies or surface indexes prepare; they do not replace original geometry. Surface tools can still be expensive because they use full detail.',
          'Use visible or selected export scope to omit hidden originals. Prefer binary GLB, STL, or .kitbash over text-heavy formats for dense geometry. When a format reports its own size limit, choose another format or a smaller subset. Deliberate decimation can help, but retain the original and inspect mating surfaces.',
        ],
      },
      {
        id: 'report-an-issue',
        title: 'Make an issue reproducible',
        paragraphs: [
          'Use Report an issue from the app’s project links. Include browser and operating system, source format and approximate triangle count, the exact error, selected tool, and the shortest steps that reproduce it. Explain expected versus achieved placement and which constraints or No clip settings were active.',
          'A screenshot from more than one angle helps with a fitting problem. A minimal non-sensitive scene or source model helps reproduce geometry issues. Check Notifications for earlier background failures that may explain the final symptom.',
        ],
      },
    ],
    related: ['saving', 'google-drive', 'performance', 'alignment'],
  },
];
