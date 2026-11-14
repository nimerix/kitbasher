import type { DocArticle } from './types';

export const startGuides: DocArticle[] = [
  {
    id: 'introduction',
    title: 'Meet Kitbasher',
    description:
      'An editable workbench for multipart models, miniature assemblies, and scanned parts.',
    group: 'Start here',
    icon: 'BookOpen',
    intro:
      'Kitbasher brings separate 3D parts into one precise assembly. Position and pose the pieces, fit their contact surfaces, inspect the joins, and keep an editable scene before exporting to your next tool.',
    image: {
      src: './images/workbench.webp',
      alt: 'Kitbasher workbench with the Scout robot, searchable Parts panel, and properties inspector.',
      caption: 'Scout · MK.04 is a complete editable sample, built from 15 separate mesh parts.',
    },
    sections: [
      {
        id: 'what-you-can-build',
        title: 'What you can build',
        paragraphs: [
          'Use Kitbasher to assemble scanned miniatures, try alternative limbs or equipment, pose connected components, arrange multipart models, or prepare named mesh objects for Blender and a slicer. Every visible piece in the sample is actual geometry you can select and edit.',
          'The workbench is especially useful when a model arrives as a collection of separate meshes. You can preserve those pieces while testing placements, then choose whether the final delivery should retain separate parts or become one mesh object.',
        ],
        table: {
          headers: ['Your task', 'Start with'],
          rows: [
            ['Place a component approximately', 'Move, Rotate, or the combined Transform tool'],
            ['Match a shaped interface', '3+ point fit or painted contact surfaces'],
            ['Make neighboring outer surfaces flush', 'Paint flush · across seams'],
            ['Keep a pose or mechanical relationship', 'Joints and retained plane constraints'],
            ['Check a join before export', 'Measure, isolation, and Interference'],
          ],
        },
      },
      {
        id: 'local-first',
        title: 'Start locally, add cloud saving when useful',
        paragraphs: [
          'You can use the workbench without creating an account. Model reading, editing, and export run in your browser. Changes recover automatically in the same browser when local recovery is available.',
          'Save a .kitbash scene to keep a portable, editable copy. Browser recovery and a downloaded scene are separate things: clearing website data or changing browsers does not transfer your recovery. Optional Google Drive connects an assembly to a cloud file for automatic saves.',
        ],
        note: {
          title: 'Keep a scene file',
          text: 'Use .kitbash for ongoing work. Export formats serve other applications and do not all preserve Kitbasher editing relationships.',
        },
      },
      {
        id: 'choose-a-path',
        title: 'A practical assembly path',
        steps: [
          'Explore the Scout sample, or start an Empty assembly from File → New assembly.',
          'Import your parts with the correct source units and up axis, then name and select the pieces you need.',
          'Frame the selection and make a coarse placement before choosing a precise fitting method.',
          'Inspect the join from several views. Add joints or retained plane constraints when the relationship should survive later edits.',
          'Save the editable scene, then export the required parts and format.',
        ],
      },
      {
        id: 'precise-without-deformation',
        title: 'Fitting keeps the part rigid',
        paragraphs: [
          'Alignment, painted contact fitting, flush fitting, and anchors translate and rotate the moving part. They do not stretch a scan to make incompatible targets agree. Residual gaps and RMS measurements help you judge the fit that is actually possible.',
          'Scaling is an explicit editing operation. Decimation and voxel remeshing explicitly change geometry and deserve a separate review of thin detail and mating surfaces. Display optimization, by comparison, keeps the original geometry for picking, fitting, saving, and export.',
        ],
      },
      {
        id: 'scope-and-requirements',
        title: 'Know the workbench’s scope',
        paragraphs: [
          'Kitbasher runs in modern WebGL browsers on Windows, macOS, and Linux, with a responsive layout for smaller screens. Available memory and graphics capacity limit the size of a scene you can comfortably edit.',
          'Import preserves geometry and vertex colors; textures, rigging, and animation are not retained. The workbench does not replace a sculpting package, a mesh-repair application, or a print slicer. In particular, a convincing visual fit does not by itself prove that a model is a closed printable solid.',
        ],
      },
    ],
    related: ['quick-start', 'workflows', 'importing', 'saving'],
  },
  {
    id: 'quick-start',
    title: 'Your first assembly',
    description: 'Learn the editing loop with Scout, then save and export your first scene.',
    group: 'Start here',
    icon: 'Rocket',
    intro:
      'The Scout · MK.04 sample lets you learn the workbench before importing a model. This walkthrough takes you through selection, framing, a controlled edit, undo, and a portable save.',
    image: {
      src: './images/transform.webp',
      alt: 'A selected Scout component with transform controls and numerical properties.',
      caption: 'Select one part to expose its transform fields and the active tool’s controls.',
    },
    sections: [
      {
        id: 'open-the-sample',
        title: '1. Open the sample',
        steps: [
          'Open Kitbasher. A fresh workbench starts with Scout · MK.04.',
          'If another scene is already open, save it first. Choose File → New assembly, then Scout · MK.04 to reload the sample.',
          'Find the Parts panel on the left and the properties inspector on the right. On a narrow screen, use the panel buttons to open them.',
        ],
        paragraphs: [
          'The sample contains 15 mesh parts and existing joints. The locked display base gives you a stationary reference while you explore.',
        ],
      },
      {
        id: 'select-and-look',
        title: '2. Select a part and look around',
        steps: [
          'Click Torso shell in the Parts list. Its properties appear in the inspector.',
          'Press F to frame the selection, or Home to frame the assembly.',
          'Middle-drag to orbit, right-drag to pan, and scroll to zoom. You can also choose Orbit with O or Pan with H and then left-drag.',
          'Press 1, 3, and 7 to compare front, right, and top views. Press 5 to switch projection.',
        ],
        note: {
          title: 'Default shortcuts',
          text: 'These guides use the default keys. Preferences → Keyboard lets you remap them, and the editor’s menus and tooltips show your current bindings.',
        },
      },
      {
        id: 'make-one-edit',
        title: '3. Make a controlled edit',
        steps: [
          'Press G for Move, or T for the combined Transform tool.',
          'Drag a handle a short distance. Hold Shift during the drag for ten times finer adjustment.',
          'For a numerical change, edit Position X in the inspector and commit the field. Related connected parts may follow their parent.',
          'Use Undo, then Redo, to see how the scene returns to each placement. A completed gizmo drag is one undo step.',
        ],
        paragraphs: [
          'If a movement stops at another part, check No clip and its allowed overlap. A locked part, connected joint, or retained constraint can also restrict the edit. Start with a small change so its effect is easy to see.',
        ],
      },
      {
        id: 'try-fitting',
        title: '4. Choose a fitting method for your next model',
        paragraphs: [
          'For your own parts, make a coarse placement with Move and Rotate, then press A for Align. Point to point translates one picked location to another; Plane to plane also orients their normals. A 3+ point fit uses at least three matching pairs spread around an interface.',
          'Use Contact paint when matching patches describe the interface better than individual points. Anchors offer a different route: place attachment points on the moving part and adjust their world targets while the part remains rigid. The detailed tool guides explain the required picks and the residual errors.',
        ],
      },
      {
        id: 'save-and-export',
        title: '5. Save the scene and make an export',
        steps: [
          'Give the assembly a useful name in the header.',
          'Choose Save scene to download an editable .kitbash file, or save the assembly to Google Drive if you have connected it.',
          'Choose Export and select a destination format. GLB keeps separate named objects for applications such as Blender; 3MF keeps multipart geometry for compatible slicers.',
          'Review the export scope before confirming. Save the .kitbash alongside the exported model so you can return to the editable assembly.',
        ],
        note: {
          title: 'Check your destination',
          text: 'Open the export in the intended application and confirm its scale and part selection. A scene save preserves editing state; an export is a delivery to another tool.',
        },
      },
    ],
    related: ['navigation', 'transforms', 'alignment', 'export'],
  },
  {
    id: 'interface',
    title: 'Around the workbench',
    description: 'Find the menus, panels, viewport tools, activity, and save status.',
    group: 'Start here',
    icon: 'PanelsTopLeft',
    intro:
      'The viewport stays at the center of the workbench. The surrounding controls help you organize parts, choose an operation, and see exactly what that operation needs next.',
    image: {
      src: './images/workbench.webp',
      alt: 'Full Kitbasher interface showing the header, tool row, scene list, viewport, inspector, and status bar.',
      caption:
        'The same scene is visible in the part list, the central viewport, and the selection inspector.',
    },
    sections: [
      {
        id: 'header-and-menus',
        title: 'Header and application menus',
        paragraphs: [
          'The header holds the assembly name, File, Edit, and View menus, save and export actions, optional cloud controls, background activity, and notifications. Rename the assembly here to make scene files easier to identify later.',
        ],
        table: {
          headers: ['Menu', 'Use it for'],
          rows: [
            [
              'File',
              'New assembly, open scene, import parts, save, Google Drive, export, and Preferences',
            ],
            [
              'Edit',
              'Undo and redo, component clipboard, duplicate, rename, delete, and selection commands',
            ],
            [
              'View',
              'Framing, grid, joints, wireframe, isolation, display colors, lighting, and panel visibility',
            ],
          ],
        },
      },
      {
        id: 'tool-row',
        title: 'Choose the operation in the toolbar',
        paragraphs: [
          'Select, Move, Rotate, Scale, Transform, Align, Contact paint, Anchors, Joint, and Measure change what a click or drag does in the viewport. The active tool determines the controls shown in the inspector.',
          'The toolbar also exposes snapping, preferred World or Local axes, and No clip. The snap amount follows the active transform: a distance for Move, an angle for Rotate, and the scale increment for Scale. A highlighted tool does not mean that an operation has already been applied; alignment and joint creation still need their picks and confirmation.',
        ],
      },
      {
        id: 'left-panel',
        title: 'Parts, Joints, and Constraints',
        paragraphs: [
          'The left panel’s Parts tab lists individual mesh objects under the assembly name. Search by name, select from the list, and use the eye and lock controls to manage each object. Triangle and part totals help explain the scene’s complexity.',
          'Joints lists parent-to-child connections and lets you select their child or remove the relationship. Constraints lists saved plane relationships with their editing and suppression controls. The search field follows the active tab.',
        ],
      },
      {
        id: 'viewport-and-inspector',
        title: 'Viewport controls and the inspector',
        paragraphs: [
          'The viewport has camera controls, view directions, projection, zoom, isolation, display settings, and Interference. The exploded-view slider separates pieces visually for inspection; reset it before evaluating their assembled contact.',
          'The right inspector follows your selection and tool. It contains transforms, material and editor colors, mesh details, connections, alignment settings, paint stages, and anchor controls as appropriate. Read its instruction text before picking a source or target. Disabled controls often explain the lock, view, or selection requirement that prevents an edit.',
        ],
      },
      {
        id: 'feedback',
        title: 'Status, background work, and notifications',
        paragraphs: [
          'The bottom status bar provides navigation hints, the next step for the active tool, and browser recovery or shared-session status. A dense mesh may need preparation before it can be picked; the status message explains when that is happening.',
          'Background activity keeps running jobs visible, with elapsed time, the current stage, and cancellation where supported. A percentage belongs to that stage, rather than promising an overall completion time. The Notifications bell retains completion and error messages after their banners close.',
          'On smaller windows, open the Parts panel and inspector only when needed. Closing a panel makes room for the viewport and does not delete a selection or remove scene geometry.',
        ],
      },
    ],
    related: ['parts', 'preferences', 'performance', 'saving'],
  },
  {
    id: 'importing',
    title: 'Import models and scans',
    description: 'Choose formats, units, orientation, and placement before bringing in geometry.',
    group: 'Start here',
    icon: 'Import',
    intro:
      'Import brings mesh parts into the current assembly. The source unit and up-axis settings matter: a correctly sized part is much easier to fit, measure, and export.',
    image: {
      src: './images/import.webp',
      alt: 'Import dialog with model formats, source units, up-axis options, and centering.',
      caption: 'Set units and the source up axis before choosing Import parts.',
    },
    sections: [
      {
        id: 'supported-formats',
        title: 'Supported model formats',
        table: {
          headers: ['Format', 'Automatic interpretation', 'Useful for'],
          rows: [
            ['STL', 'Millimeters, Z up', 'Individual scans and printable mesh parts'],
            ['OBJ', 'Millimeters, Z up', 'Named mesh components and vertex-colored geometry'],
            ['GLB / embedded GLTF', 'Meters, Y up', 'Self-contained multipart geometry'],
            ['3MF', 'Declared 3MF units, Z up', 'Multipart models with unit metadata'],
          ],
        },
        paragraphs: [
          'Use File → Open scene for a .kitbash file. Import is for model geometry; opening a scene restores Kitbasher’s saved editing state and replaces the workbench after confirmation.',
        ],
      },
      {
        id: 'import-step-by-step',
        title: 'Bring in one or several files',
        steps: [
          'Choose Import parts, File → Import, or the plus button in the scene collection. You can also drop model files into the editor.',
          'Choose the source files. Review their names and sizes in the import dialog, removing any file you do not need.',
          'Set Source units and Up axis, or leave Automatic by format when the source follows its usual convention.',
          'Choose whether to Center the imported assembly on the ground plane.',
          'Select Import parts and wait for reading and preparation to complete. The new pieces are added to the existing scene.',
        ],
      },
      {
        id: 'units-and-orientation',
        title: 'Get size and orientation right',
        paragraphs: [
          'The workbench expresses distances in millimeters. You can override source units with millimeters, centimeters, meters, or inches. For example, an STL authored in inches needs Inches selected because STL does not declare its units.',
          'Choose Z up for a CAD-style source or Y up for a glTF-style source. Kitbasher converts the source into its working orientation. Automatic 3MF import reads the model’s declared unit factor when available; an explicit unit choice overrides it.',
          'Check one known dimension after importing. A model that is 1,000 times too large or small usually indicates a meter-to-millimeter mismatch. Correcting the import interpretation is preferable to repeatedly guessing a scale value.',
        ],
      },
      {
        id: 'preserved-content',
        title: 'What is preserved',
        paragraphs: [
          'Relative placement between imported components is preserved. Centering moves the imported assembly together onto the ground plane; it does not independently scatter each part around the origin. Mesh origins are rebased around their geometry while keeping the original world placement, which makes handles useful on scans with distant scanner origins.',
          'Geometry and vertex colors are retained. Textures, rigging, and animation are not retained. Use a self-contained GLB or embedded GLTF rather than expecting a folder of external buffers and texture sidecars to be restored as a textured character.',
        ],
      },
      {
        id: 'large-and-damaged-files',
        title: 'Large files and failed imports',
        paragraphs: [
          'There is no single practical file-size promise: a compressed file may expand into much more geometry, and browser memory and draw limits differ from disk size. Kitbasher reports files that exceed its parsing or drawable-buffer limits and reports allocation failures separately from damaged data.',
          'For an oversized model, split it into smaller components or prepare a lighter copy in a mesh application. GLB can avoid text-format limits, while very large 3MF model text can hit browser string limits. Close unrelated heavy tabs when memory is scarce, and retain the original source files.',
        ],
        note: {
          title: 'Inspect the result',
          text: 'Import success confirms that geometry was read. Check its scale, orientation, part count, and surface appearance before building a precise assembly.',
        },
      },
    ],
    related: ['quick-start', 'parts', 'measurement', 'performance'],
  },
  {
    id: 'navigation',
    title: 'Navigate and isolate',
    description: 'Control the camera, frame a join, and reveal only the surfaces you need.',
    group: 'Start here',
    icon: 'Orbit',
    intro:
      'Camera movement changes your view of the assembly. Framing, orbit pivots, and temporary isolation help you inspect a tight joint without changing the model’s saved placement.',
    image: {
      src: './images/display.webp',
      alt: 'The Scout assembly in Kitbasher’s viewport with view and display controls.',
      caption: 'Use view directions and projection alongside free orbiting to judge a placement.',
    },
    sections: [
      {
        id: 'mouse-and-touch',
        title: 'Mouse and touch controls',
        table: {
          headers: ['Action', 'Default control'],
          rows: [
            ['Orbit', 'Middle-drag; hold Space and left-drag; or choose Orbit (O) and left-drag'],
            [
              'Pan',
              'Right-drag or Shift + left-drag; choose Pan (H) for persistent left-drag panning',
            ],
            ['Zoom', 'Scroll, pinch, or viewport zoom buttons'],
            ['Touch', 'One finger follows the active camera mode; two fingers pan and zoom'],
            ['Return from a camera tool', 'Esc, keeping unfinished alignment picks'],
          ],
        },
        paragraphs: [
          'While picking alignment points or painting contacts, use middle-drag or Space + drag to orbit without replacing the active operation. Right-drag still pans; a stationary right-click opens contextual controls.',
        ],
      },
      {
        id: 'framing-and-projection',
        title: 'Frame the part and compare views',
        paragraphs: [
          'Press F to frame the selection and Home to frame all currently relevant parts. With isolation active, Frame all frames the isolated view. Double-clicking a part in the Parts panel also requests a focus.',
          'Press 1 for Front, 3 for Right, and 7 for Top. Press 5 to switch between perspective and orthographic projection. Orthographic views are useful for checking apparent offsets without perspective foreshortening; orbit afterward to confirm depth and clearance.',
          'Zoom and panning do not edit geometry. Tune wheel speed, smoothing, and direction in Preferences when the default movement feels too fast for a small interface.',
        ],
      },
      {
        id: 'orbit-centers',
        title: 'Choose a useful orbit center',
        paragraphs: [
          'Orbit selection is enabled initially and uses a selected part’s custom pivot, or the visible center of the selected parts. Shift + . toggles the preference. Press . to center the orbit on the selection once while keeping the current zoom and direction.',
          'Press P, then click a model surface to create a custom pivot. The marker follows its part and also becomes the pivot for rotation and scale, except where an active joint supplies its own anchor. Reset custom pivot returns to the mesh center.',
          'Panning moves the camera freely. Orbiting then carries the panned view around the selection without automatically snapping the view back. Use explicit centering or framing when you want to recenter.',
        ],
      },
      {
        id: 'isolate',
        title: 'Temporarily isolate a selection',
        steps: [
          'Select one part or a set of parts and press I.',
          'Work with only those parts drawn. Select a different part in the Parts panel and press I to move the isolation to it.',
          'Press I again without a new selection to return to the full view.',
        ],
        paragraphs: [
          'Isolation is temporary view state: it does not change saved visibility, undo history, or exported visibility. The other parts remain in the assembly and still participate in joints, retained constraints, and No clip.',
          'Hide others in the context menu is different: it changes part visibility in the scene, is undoable, and affects exports scoped to visible parts.',
        ],
      },
      {
        id: 'nearby-surfaces',
        title: 'Keep just the surrounding interface',
        paragraphs: [
          'Press Shift + I to isolate with Nearby surfaces. The surrounding objects are cut away except where their surfaces are near the isolated part. The default distance is 2 mm, adjustable up to 200 mm in the viewport isolation bar.',
          'Visible nearby surfaces remain available for selection, alignment picks, joints, measurement, and painting. Cut-away surfaces cannot be picked. The cut follows the isolated parts as they move, but its distance field has finite resolution; use measurement and Interference for final gap evaluation.',
          'Alignment also offers Isolate both parts, Active part only, and Ghost other part. Those views follow the next source or target stage and restore the preceding scene view when the operation finishes or is canceled.',
        ],
      },
    ],
    related: ['parts', 'alignment', 'display', 'preferences'],
  },
  {
    id: 'parts',
    title: 'Manage parts and selections',
    description: 'Select, name, duplicate, lock, hide, and reuse the components of an assembly.',
    group: 'Build & assemble',
    icon: 'Boxes',
    intro:
      'A Kitbasher scene contains individual mesh parts and the relationships between them. Keep those parts organized and editable while exploring poses and alternative builds.',
    image: {
      src: './images/joints.webp',
      alt: 'Kitbasher parts and joint controls for an editable multipart Scout assembly.',
      caption: 'Parts remain individually selectable even when joints connect their movement.',
    },
    sections: [
      {
        id: 'selection',
        title: 'Select exactly what you need',
        paragraphs: [
          'Click a visible component in the viewport or its row in the Parts panel. Hold Shift, Ctrl, or ⌘ while clicking to add or remove parts from a selection. Search parts by name to reach an internal or obscured component without picking through other surfaces.',
          'Select All includes hidden and locked components. Check the resulting selection before an operation; move, cut, and delete still respect locks. A multiple selection acts together for supported transforms, but it does not create a persistent named folder or a new mesh object.',
        ],
        table: {
          headers: ['Action', 'Default shortcut'],
          rows: [
            ['Select all', 'Ctrl/⌘ + A'],
            ['Deselect all', 'Ctrl/⌘ + Shift + A; Esc in Select mode'],
            ['Find a part', 'Ctrl/⌘ + F'],
            ['Rename one component', 'F2'],
            ['Duplicate selected', 'Ctrl/⌘ + D'],
            ['Delete unlocked parts', 'Delete or Backspace'],
          ],
        },
      },
      {
        id: 'visibility-and-locks',
        title: 'Visibility and locks have different jobs',
        paragraphs: [
          'Use the eye control beside a part to hide or show it. Visibility belongs to the scene and matters when exporting visible parts. Use the lock control to protect a stationary reference or a component whose placement is already established.',
          'A hidden component still exists in the scene. A locked component can still be selected for inspection and unlocking. Temporary isolation is useful when you only want a cleaner view; it leaves the saved visibility unchanged.',
        ],
      },
      {
        id: 'component-clipboard',
        title: 'Copy components between assemblies',
        steps: [
          'Select the components to reuse and choose Copy components or Ctrl/⌘ + C.',
          'Keep the same editor tab open. You can open a different scene before pasting.',
          'Paste with Ctrl/⌘ + V. The pasted parts are visible, unlocked, and selected.',
          'Review the new placement and relationships, then save the destination assembly.',
        ],
        paragraphs: [
          'The component clipboard belongs to the open editor and clears on reload. It retains geometry, colors, transforms, pivots, and joints or plane constraints between copied parts. Relationships to components outside the selection are omitted.',
          'Copies paste with a 12 mm X offset and another 12 mm for each subsequent paste. The first paste after a cut restores the original placement. Clipboard edits and duplication can be undone.',
        ],
      },
      {
        id: 'relationships',
        title: 'Understand the connection structure',
        paragraphs: [
          'Joints define parent-to-child relationships rather than turning several meshes into one. Moving a parent can carry its connected descendants, and the child’s permitted motion follows the joint anchors and locks. Inspect the Joints tab and the child’s Connections section when movement is unexpected.',
          'Retained plane constraints are listed separately in Constraints. They preserve geometric relationships after fitting. Suppress or edit a relationship deliberately instead of repeatedly trying to drag against it.',
        ],
      },
      {
        id: 'context-and-merge',
        title: 'Context actions and permanent combinations',
        paragraphs: [
          'Right-click a component in the viewport or Parts panel for transform, clipboard, rename, delete, alignment, painting, joints, merge, inspection, isolation, visibility, and lock actions. Right-clicking a selected part preserves the whole selection. Shift + F10 or the Menu key also opens the context menu.',
          'Merge selected replaces selected parts and their joints with one mesh object. Combine meshes preserves the original triangles; Boolean union attempts to fuse overlapping solid volumes. Save a scene copy before merging if you want the separate assembly available later. Undo reverses the merge while that history remains available.',
        ],
      },
    ],
    related: ['joints', 'planes', 'navigation', 'inspection'],
  },
  {
    id: 'workflows',
    title: 'Assembly workflows',
    description:
      'Practical approaches for miniatures, scanned interfaces, variants, and print preparation.',
    group: 'Start here',
    icon: 'Workflow',
    intro:
      'Choose the simplest operation that describes the relationship you need. A coarse placement, a well-chosen fit, and a careful inspection usually work better than repeatedly nudging an entire assembly.',
    image: {
      src: './images/scene-workflow.svg',
      alt: 'Assembly workflow from importing separate parts through fitting, inspection, saving, and export.',
      caption: 'Keep an editable scene throughout the import, fit, inspect, and export cycle.',
    },
    sections: [
      {
        id: 'miniature-from-parts',
        title: 'Assemble a miniature from separate parts',
        steps: [
          'Start an Empty assembly and import the required parts using a consistent unit interpretation.',
          'Rename ambiguous pieces and lock the base or main body that should remain stationary.',
          'Use Move and Rotate for rough positioning. Frame the next interface and isolate with nearby surfaces if needed.',
          'Choose an alignment method that matches the geometry: a plane for a flat seat, several point pairs for a keyed join, or painted contacts for irregular mating areas.',
          'Inspect the silhouette and connection from front, side, rear, and underneath. Add a joint or retained plane relationship where later editing should preserve it.',
          'Save a named .kitbash scene before preparing the export.',
        ],
      },
      {
        id: 'manual-guided',
        title: 'Work from an assembly manual or reference',
        paragraphs: [
          'Keep the manual or reference image open beside the workbench. Match the required configuration before fine fitting: left and right variants, equipment choices, head direction, and the intended support points can matter more than a numerically small gap.',
          'Compare several viewpoints rather than accepting a single front silhouette. Look for seated shoulders, aligned cables, continuous armor edges, clear weapon paths, and feet touching their intended pads. Kitbasher’s view directions and isolation help you see these relationships; the manual remains an external visual reference.',
        ],
      },
      {
        id: 'scanned-parts',
        title: 'Fit imperfect scanned interfaces',
        paragraphs: [
          'Begin with the original scan and a small number of well-separated matching regions. A 3+ point fit gives a useful coarse registration; painted contact fitting compares the actual painted surfaces. Spread pairs around the interface so a symmetric patch does not leave an ambiguous orientation.',
          'For final adjustments, use rigid anchors to expose target gaps or Paint flush across seams to balance outer-surface continuity against several neighbors. Read the residuals. Incompatible interfaces leave an error because the tools preserve the rigid part rather than stretching it.',
        ],
        note: {
          title: 'Preserve the source',
          text: 'Display optimization keeps the original geometry. Explicit decimation and remeshing change it, so evaluate a processed copy against the original mating surfaces before relying on it.',
        },
      },
      {
        id: 'variants',
        title: 'Explore alternative poses and builds',
        paragraphs: [
          'Save separate, clearly named scene files for configurations you want to preserve. Duplicate or copy a set of components to explore an alternative, remembering that copied relationships only include selected parts.',
          'Hide unused equipment while reviewing one option and inspect export scope carefully. Hidden alternatives remain in the scene and are included by an all-parts export. A connected joint can preserve an anchor while you try different permitted rotations; locks and plane constraints may need deliberate adjustment for a new pose.',
        ],
      },
      {
        id: 'print-preparation',
        title: 'Prepare the result for a slicer',
        steps: [
          'Reset exploded view and inspect the assembly in its actual placement.',
          'Use Measure to check important distances and Interference to inspect gaps and overlapping pairs.',
          'Keep separate parts when the destination supports multipart objects. Use Combine meshes only when you need one object while retaining its triangle surfaces.',
          'Use Boolean union only with suitable closed, manifold meshes and review the resulting geometry.',
          'Export the intended scope, open it in the slicer, and verify scale, surfaces, and the actual sliced result.',
        ],
        paragraphs: [
          'A visual fit, a combined mesh, and a printable solid are different milestones. Kitbasher does not automatically fill gaps or repair every scan defect. Keep the editable scene and original meshes so you can return to an earlier stage.',
        ],
      },
    ],
    related: ['alignment', 'contact-paint', 'anchors', 'inspection', 'export'],
  },
  {
    id: 'inspection',
    title: 'Inspect contact and interference',
    description:
      'Read overlap volumes, near-surface bands, gaps, and analysis warnings before combining parts.',
    group: 'Inspect & finish',
    icon: 'ScanEye',
    intro:
      'Interference helps you judge how parts meet at their actual assembled positions. It overlays solid overlaps and nearby surfaces while leaving the source meshes editable.',
    image: {
      src: './images/inspection.webp',
      alt: 'Interference inspection controls with solid-overlap and nearby-surface options.',
      caption: 'Use a distance threshold and a focused comparison scope to inspect an interface.',
    },
    sections: [
      {
        id: 'run-a-check',
        title: 'Run a focused inspection',
        steps: [
          'Click Interference beside the projection selector. Exploded view returns to the assembled position and stays unavailable until inspection closes.',
          'Choose All visible parts, or select at least two visible components and choose Selected parts (2+).',
          'Enable Solid overlap, Nearby surfaces, or both.',
          'Set Within distance in millimeters and press Enter or leave the field to update it.',
          'Wait for the background check and review the pair list and any analysis notes.',
        ],
        paragraphs: [
          'For a large scene, start with two parts at the join you are checking. Temporary isolation also limits the view and the visible parts available for inspection.',
        ],
      },
      {
        id: 'read-the-overlays',
        title: 'Read the overlays and metrics',
        table: {
          headers: ['Result', 'Meaning'],
          rows: [
            ['Red geometry', 'Solid overlap between eligible closed meshes'],
            ['Amber surfaces', 'Surface regions within the chosen distance of another part'],
            [
              'Closest-point markers',
              'The nearest surface-point pair and its gap for a nearby pair',
            ],
            ['Pairwise overlap, mm³', 'Sum of the reported overlap volumes for individual pairs'],
            ['Gap, mm', 'The reported closest distance for that pair'],
          ],
        },
        paragraphs: [
          'For example, Within distance = 0.5 mm reveals regions close to another surface, including the interface. Amber is proximity, not a declaration that the surfaces are correctly seated.',
          'Turn off Show surrounding parts to concentrate on inspection geometry. The pair list identifies the component names, overlap volume or gap, and overall checked-pair totals. It is an on-screen analysis panel rather than an exportable inspection report.',
        ],
      },
      {
        id: 'interpret-limits',
        title: 'Interpret accuracy and partial results',
        paragraphs: [
          'The near-surface band is an adaptive sampled estimate. Its approximate spatial detail is shown in the panel, and a reached detail budget is reported. Use the displayed resolution when judging very narrow bands.',
          'Solid overlap assumes closed, consistently wound geometry. Open or non-manifold scans produce partial-analysis warnings while proximity checks remain useful. Self-intersections and incorrect winding can also affect the solid result.',
          'Overlap is summed per pair. A region shared by three components can contribute to multiple pairs, so the sum is not necessarily the volume of a single union of all overlaps.',
        ],
      },
      {
        id: 'updates-and-progress',
        title: 'Keep working while checks run',
        paragraphs: [
          'Movement, alignment, undo, redo, and visibility changes update the analysis after a short pause. Superseded checks are canceled and stale overlays clear. Camera controls remain available, and you can collapse the inspection controls to reclaim viewport space.',
          'Detailed models can take several minutes. Read the current stage in the panel or Background activity; a stage percentage does not estimate all remaining work. Cancel inspection stops the worker, and Try again starts a new check after cancellation or an error.',
        ],
      },
      {
        id: 'choose-a-merge',
        title: 'Decide whether to combine or fuse',
        paragraphs: [
          'After inspecting the placement, select at least two unlocked parts and choose Merge selected. Combine meshes creates one object while keeping all original triangles. It is useful for scanned pieces but does not remove internal overlap or repair holes.',
          'Boolean union fuses overlapping volumes and requires closed, manifold input. It may need prior scan repair. Both merge modes replace the selected parts and their joints and can be undone. Give the merged result a name and save a scene copy beforehand when you need to retain the separate assembly.',
        ],
        note: {
          title: 'Check the final delivery',
          text: 'No clip helps during editing, and Interference helps inspect a placement. Neither replaces checking the exported model and its sliced geometry in your print workflow.',
        },
      },
    ],
    related: ['measurement', 'no-clip', 'performance', 'export'],
  },
];
