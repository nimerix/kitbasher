import type { DocArticle } from './types';

export const assemblyGuides: DocArticle[] = [
  {
    id: 'transforms',
    title: 'Move, rotate & scale',
    description:
      'Place parts with handles, exact values, fine steps, custom pivots, and free pointer transforms.',
    group: 'Build & assemble',
    icon: 'move',
    intro:
      'Use transforms for coarse placement, posing, and precise finishing. The same parts can be adjusted with a combined gizmo, separate tools, numeric fields, or free pointer movement. Joints, retained plane constraints, and No clip continue to govern the achieved placement.',
    image: {
      src: './images/transform.webp',
      alt: 'A selected Kitbasher part with transform handles and the transform inspector.',
      caption:
        'Handles provide direct placement; the inspector exposes the axes, pivot, and exact adjustment controls.',
    },
    sections: [
      {
        id: 'choose-tool',
        title: 'Choose a transform tool',
        paragraphs: [
          'Select a part in the viewport or Parts panel. Shift-click adds parts to a selection so they can move together. Choose Move, Rotate, or Scale in the toolbar, or use the default shortcuts G, R, and S. Use T for Transform, which combines movement, rotation, and scaling in one gizmo.',
        ],
        table: {
          headers: ['Handle', 'Action'],
          rows: [
            ['Arrow', 'Move along one axis.'],
            ['Square between axes', 'Move within that plane.'],
            ['Rotation ring', 'Rotate about its axis.'],
            ['Axis cube', 'Scale along its axis.'],
            ['White center cube', 'Scale uniformly.'],
          ],
        },
        note: {
          title: 'Keep assembly scale intentional',
          text: 'Uncheck Enable scaling in the Transform inspector to hide scale handles. This browser preference also appears under Preferences → Navigation → Transform tool. The separate Scale tool and numeric scale fields remain available.',
        },
      },
      {
        id: 'precise-steps',
        title: 'Use exact values and repeatable steps',
        steps: [
          'Choose Move or Rotate and set Step in the inspector, in millimeters or degrees.',
          'Click the X, Y, or Z −/+ buttons to adjust the whole selection by that amount.',
          'Enable Snap dragging when handle movement should use the same increment.',
          'Use the absolute position, rotation, and scale fields when a specific final value is required. Read their coordinate-system label before entering values.',
        ],
        paragraphs: [
          'The combined Transform tool has separate Move snap and Rotation snap values. Scale snapping uses 10% increments. Each step-button adjustment is one undo step, and one continuous handle drag is one undo step. Undo and redo keep the transform tool active so you can continue refining the pose.',
        ],
      },
      {
        id: 'axes-and-pivot',
        title: 'Choose axes and a useful pivot',
        paragraphs: [
          'World axes stay aligned with the scene. Local axes follow a single part’s orientation. Multiple selected parts use world axes, and connected parts use their joint axes. The inspector identifies the active axes and rotation pivot rather than assuming every selection behaves the same way.',
          'For a custom pivot, press P or choose Pick surface pivot in the Camera controls, then click a spot on the model. Rotation, scaling, and orbiting can use this point. The marker follows its part; Reset custom pivot returns to the mesh center. Active joints retain their own rotation anchors. Custom pivots are undoable and saved with the scene.',
        ],
      },
      {
        id: 'fine-movement',
        title: 'Make fine adjustments',
        paragraphs: [
          'Hold Shift during a gizmo drag for one-tenth sensitivity. Press or release it during the same gesture without jumping to another pose. This is useful for small seam corrections after rough placement.',
          'For a scan with a distant scanner origin, the gizmo is placed on the visible geometry. Imported meshes are rebased around their centers while their original world placement is preserved, so you can work near the actual part.',
        ],
      },
      {
        id: 'free-pointer',
        title: 'Move and rotate without holding a button',
        steps: [
          'Select the part, place the pointer over the viewport, and press Shift + G for free movement or Shift + R for free rotation.',
          'Release the shortcut, then move the pointer. Movement follows the view plane; rotation acts like a trackball around the selected pivot.',
          'Press X, Y, or Z to constrain an axis. Press the same axis again to return to free movement. Hold Shift after releasing the shortcut for fine control.',
          'Press Enter or left-click to confirm. Press Esc or right-click to restore the starting poses. The viewport prompt also has Confirm and Cancel buttons.',
        ],
        paragraphs: [
          'Free transforms respect the current axes, snapping, joints, and No clip. Preview movement remains local until confirmed. Clicking another interface control, losing window focus, resizing the viewport, or receiving a changed shared scene cancels the preview.',
        ],
      },
      {
        id: 'blocked-movement',
        title: 'Understand a blocked adjustment',
        bullets: [
          'Locked or hidden parts, exploded view, and active camera or picking modes can make transform controls unavailable. Read the explanation in the inspector.',
          'A connected joint may carry neighboring parts or pin translation through a fixed part. Free the appropriate joint axis or change Keep connected if independent positioning is intended.',
          'An active plane constraint preserves its relationship through later transforms. Suppress the relationship in Constraints when you need free placement.',
          'No clip may stop or shift the requested placement at another visible surface. Check the allowed overlap and the reported obstruction.',
        ],
      },
    ],
    related: ['alignment', 'anchors', 'joints', 'no-clip'],
  },
  {
    id: 'alignment',
    title: 'Align parts',
    description:
      'Match points and planes, build a multi-point rigid fit, and inspect the achieved error.',
    group: 'Build & assemble',
    icon: 'align',
    intro:
      'Alignment places one moving part against a stationary target using picked surface points and normals. Choose a simple relationship for a clear mechanical interface, or a rigid multi-point fit when several landmarks should agree. Fitting preserves the part’s scale and shape.',
    image: {
      src: './images/alignment.webp',
      alt: 'Kitbasher alignment inspector showing alignment methods and moving and target part selectors.',
      caption: 'Choose the method and the two parts before picking corresponding features.',
    },
    sections: [
      {
        id: 'pick-a-method',
        title: 'Choose the relationship you need',
        table: {
          headers: ['Method', 'What it solves', 'Useful for'],
          rows: [
            [
              'Point to point',
              'Translates the picked moving point to the target point; rotation stays unchanged.',
              'Coarse seating and moving a known landmark.',
            ],
            [
              'Point to plane',
              'Projects the source point along the target plane normal; rotation stays unchanged.',
              'Bringing a point to a flat supporting surface.',
            ],
            [
              'Plane to plane',
              'Orients picked face normals and seats the picked points.',
              'Flat mating faces and bases.',
            ],
            [
              '3+ point fit',
              'Uses all matching pairs to solve one rigid translation and rotation.',
              'Scanned interfaces with several recognizable landmarks.',
            ],
            [
              'Paint contact surfaces',
              'Fits matching painted surface regions.',
              'Broad or irregular contacts that are difficult to identify with exact points.',
            ],
          ],
        },
        image: {
          src: './images/alignment-methods.svg',
          alt: 'Diagrams comparing point translation, point projection onto a plane, and plane alignment.',
          caption: 'A point match controls location; plane methods also use surface direction.',
        },
      },
      {
        id: 'first-alignment',
        title: 'Apply a point or plane alignment',
        steps: [
          'Select the moving part, choose Align in the toolbar, or press A.',
          'Choose an Alignment method. Check Moving part and Target part or plane in the inspector. A world reference plane can be the target for point and plane methods.',
          'Click a surface point on the moving part, then its matching point or plane on the target.',
          'Review the matching pair. For Plane to plane, choose the face-normal direction and any Surface offset needed.',
          'Click Apply alignment or press Enter. Undo restores the previous placement.',
        ],
        paragraphs: [
          'Opposing face normals is appropriate when two mating faces should look toward one another. A positive outward surface offset can leave clearance rather than seating exactly on the target surface.',
        ],
      },
      {
        id: 'multi-point',
        title: 'Build a stable 3+ point fit',
        paragraphs: [
          'Choose 3+ point fit, then alternate source and target clicks for at least three matching pairs. Keep adding fourth, fifth, or later pairs when they provide meaningful information; there is no three-pair cap. Spread landmarks across the interface and avoid points on one line.',
          'The inspector numbers every pair, shows an unfinished source pick, and lets you remove individual pairs. Finish or clear a pending source before applying. All completed pairs contribute to the rigid best fit; adding poor correspondences can make the result worse.',
        ],
        note: {
          title: 'RMS describes the achieved fit',
          text: 'A low RMS means the chosen point correspondences agree closely after fitting. It does not prove that unpicked surfaces match, that the pose matches a reference image, or that the assembly has no interference.',
        },
      },
      {
        id: 'clear-view',
        title: 'Expose the surfaces you need to pick',
        bullets: [
          'Full scene keeps the ordinary workspace visible.',
          'Isolate both parts temporarily hides the rest of the scene.',
          'Active part only shows the part needed for the next source or target pick and follows the workflow automatically.',
          'Ghost other part makes the other part translucent and click-through while keeping the active part solid.',
        ],
        paragraphs: [
          'Focused alignment views require two visible parts. After completing a single pair, both parts appear for review. Returning to Full scene, finishing, or canceling restores the previous view, including earlier isolation. These views do not change saved part visibility or export scope.',
        ],
      },
      {
        id: 'navigate-between-picks',
        title: 'Inspect from another angle without losing picks',
        paragraphs: [
          'Middle-drag or hold Space while left-dragging to orbit. Right-drag pans and the wheel zooms. O and H select persistent Orbit and Pan tools; Esc returns to the alignment workflow without clearing its picked pairs. Use these controls to reach a hidden underside rather than guessing its location through another part.',
          'Review the result from several angles. One correct silhouette can conceal a rotated interface or an offset join on the opposite side.',
        ],
      },
      {
        id: 'constraints-and-errors',
        title: 'Interpret constrained results',
        paragraphs: [
          'Existing joints and plane constraints stay authoritative. An alignment can carry connected parts while keeping the target stationary. Joint axes, fixed anchors, and No clip may prevent the unconstrained solution; the preview and displayed RMS describe the achieved result.',
          'If the fit is constrained, inspect the active relationships and collision note before adding more pairs. For a rough scan, a small allowed overlap may help seat the surfaces. For a persistent mechanical relationship, use a retained plane constraint instead of repeatedly applying a one-time fit.',
        ],
      },
    ],
    related: ['contact-paint', 'planes', 'anchors', 'no-clip'],
  },
  {
    id: 'contact-paint',
    title: 'Paint contact surfaces',
    description:
      'Paint matching contact patches and fit irregular interfaces without deforming the source mesh.',
    group: 'Build & assemble',
    icon: 'paint',
    intro:
      'Contact paint describes where two parts belong together by marking regions on their actual triangles. It is useful for scanned sockets, uneven interfaces, and surfaces where a single picked point is ambiguous. A contact fit balances several matching patch pairs in one rigid placement.',
    image: {
      src: './images/contact-paint.webp',
      alt: 'Kitbasher contact-paint tool with surface relationship, painted pairs, and brush controls.',
      caption: 'Paint paired regions on the moving and target parts, then review the contact fit.',
    },
    sections: [
      {
        id: 'paint-first-pair',
        title: 'Paint your first matching pair',
        steps: [
          'Select the moving part and press B, or choose Contact paint in the toolbar.',
          'Choose the Moving part and Target part. Keep the contact-fitting surface relationship selected.',
          'Paint a small contact area on the moving part.',
          'Choose Next: paint target and paint the matching contact area on the target.',
          'Finish the pair, add another, and repeat until at least three complete pairs describe the interface.',
          'Review the preview and Contact RMS, then choose Fit contact surfaces.',
        ],
        paragraphs: [
          'There is no fixed maximum pair count. Unfinished pairs must be completed or removed before fitting. Three widely separated, useful regions are generally more informative than several nearly identical patches beside one another.',
        ],
      },
      {
        id: 'brush',
        title: 'Control and revise the brush',
        table: {
          headers: ['Control', 'Action'],
          rows: [
            ['Brush radius', 'Sets the radius in millimeters.'],
            ['[ and ]', 'Shrink or grow the brush.'],
            ['Erase or Alt while painting', 'Removes triangles from the active patch.'],
            [
              'Undo last paint stroke',
              'Restores the previous paint stroke; Ctrl/⌘ + Z also undoes paint.',
            ],
            [
              'Right-click in the viewport',
              'Opens brush settings, including radius, paint/erase, stroke undo, and seed-plane limits.',
            ],
          ],
        },
        paragraphs: [
          'The right-click menu and inspector share the same settings. Choose Done, press Esc, or click outside the menu to continue painting. Brush marks follow whole triangles, so a smaller brush cannot add detail that the mesh itself does not contain.',
        ],
      },
      {
        id: 'contiguous-patches',
        title: 'Keep each patch on one connected region',
        paragraphs: [
          'A patch grows through shared mesh edges and remains contiguous across strokes. A disconnected surface will not join the same patch merely because it is nearby or lies in the same plane. Use another matching pair for a separate island of contact.',
          'Erasing a bridge keeps the seeded connected component, or the largest remaining component if the seed was erased. If a stroke appears to remove more than expected, check whether it separated the painted region into disconnected pieces.',
        ],
      },
      {
        id: 'seed-plane',
        title: 'Limit paint to a locally flat interface',
        paragraphs: [
          'Enable Stay on seed plane when paint should remain close to the first hit’s orientation and plane. Normal tolerance is measured in degrees; plane tolerance is measured in millimeters. These limits help avoid spilling onto steep socket walls or a nearby raised detail.',
          'The first hit defines the seed plane. Clear the patch before painting when you need a different seed. Use small, locally useful areas rather than covering broad curved geometry simply to increase the painted area.',
        ],
      },
      {
        id: 'surface-fit',
        title: 'Understand what the fit measures',
        paragraphs: [
          'Fit contact surfaces starts from patch centers and normals, then refines symmetric closest-surface matches within each numbered pair. Samples are spread by surface area, and opposing normals are the default for mating contact.',
          'Contact RMS measures sampled distances to the actual matching painted surfaces after joint constraints. The solve preserves scale and does not bend or stretch the scan. It is a local fit: rough placement and distinct correspondences matter, especially for round, repeated, or symmetric interfaces.',
        ],
        note: {
          title: 'Check the rest of the assembly',
          text: 'A close painted fit can still collide with an unpainted neighbor. Keep No clip on when appropriate, and inspect solid interference before exporting a finished assembly.',
        },
      },
      {
        id: 'navigate-or-change-method',
        title: 'Reach hidden contacts and choose other relationships',
        paragraphs: [
          'Use Alignment view to isolate both parts, show the active part only, or ghost the other part. Middle-drag or Space + left-drag orbits without losing paint; right-drag pans and the wheel zooms.',
          'For an outer surface continuing across an intentional gap, choose Paint flush · across seams. For flat mechanical relationships that should persist through future edits, choose Mate planes, Parallel, Perpendicular, or Angle and enable Keep constraint active. These methods solve different relationships from the three-pair contact fit.',
        ],
      },
    ],
    related: ['alignment', 'flush-fit', 'planes', 'no-clip'],
  },
  {
    id: 'flush-fit',
    title: 'Fit surfaces across seams',
    description:
      'Correct height and tilt across several neighboring seams while preserving sideways spacing.',
    group: 'Build & assemble',
    icon: 'layers',
    intro:
      'Paint flush is for surfaces that should continue smoothly from one part to the next, such as armor panels or a scan split into separate pieces. Paint across the seam to describe both sides. Kitbasher makes a small rigid correction to the moving part while keeping painted neighbors stationary.',
    image: {
      src: './images/flush-seams.svg',
      alt: 'A moving surface is adjusted in height and tilt to continue across seams with stationary neighboring surfaces.',
      caption:
        'Flush fitting balances height and tilt at the seams without pulling patch centers together.',
    },
    sections: [
      {
        id: 'when-to-use',
        title: 'Choose flush fitting for surface continuity',
        paragraphs: [
          'Use this method when the outside faces should have matching height and outward direction, while the gap or sideways position should remain. It differs from mating contact surfaces, where corresponding regions are brought together.',
          'Begin near the intended pose. Flush fitting is a local adjustment limited to 30° from the starting orientation, with a small motion penalty that favors minimal corrections. If a part is far away or turned backward, place it roughly with transforms or alignment first.',
        ],
      },
      {
        id: 'paint-seam',
        title: 'Paint and apply a seam',
        steps: [
          'Select the moving part and press B to open Contact paint.',
          'Under Surface relationship, choose Paint flush · across seams.',
          'Drag from a small outer surface on the moving part, across the gap, and onto its stationary neighbor. The stroke paints both sides automatically.',
          'With the moving part chosen, strokes can also start on a neighbor. Repaint either side to extend the region, or use Alt / Erase and stroke undo to revise it.',
          'Inspect the cyan preview, height error, and tilt error.',
          'Choose Apply flush fit to commit one undoable edit.',
        ],
        paragraphs: [
          'Unlike contact painting, this workflow does not require a separate Next: paint target stage. One complete seam is sufficient; add more seams when several connections should remain aligned together.',
        ],
      },
      {
        id: 'multiple-neighbors',
        title: 'Balance several seams in one fit',
        paragraphs: [
          'Choose Add seam for every additional connection the moving part should satisfy. Each seam can reference a different stationary neighbor. All painted regions participate in one translation and rotation, so a correction at one edge is balanced against the other painted edges.',
          'Paint every important interface explicitly. An unpainted connection without a joint or retained constraint is not automatically preserved by the fit. For a central panel surrounded by several parts, include seams around the panel rather than checking only its most visible edge.',
        ],
      },
      {
        id: 'read-residuals',
        title: 'Read the preview and remaining errors',
        paragraphs: [
          'The cyan ghost previews the solved placement without moving the original geometry. Per-seam height and tilt errors describe each connection. Overall height RMS and maximum tilt summarize how well all seams agree.',
          'Residuals above 0.05 mm or 1° are flagged rather than described as exact. Conflicting seams, curved patches, joints, fixed locks, and retained plane constraints can require a compromise. A remaining error is a reason to inspect the setup, not to assume the mesh has deformed to satisfy it.',
        ],
        note: {
          title: 'Paint locally flat regions',
          text: 'Small patches beside a seam give a meaningful fitted plane. A broad curved patch supplies only an approximate plane and can hide the surface detail you actually want to match.',
        },
      },
      {
        id: 'what-changes',
        title: 'Understand the limits of a flush fit',
        bullets: [
          'The moving part translates and rotates; its scale and mesh shape remain unchanged.',
          'Painted neighbors stay fixed. Connected descendants may follow the moving part.',
          'Existing joints, fixed part locks, and retained plane constraints remain authoritative.',
          'No clip can limit the achieved correction at another part’s surface.',
          'The operation does not weld surfaces, fill a gap, or create new geometry.',
        ],
      },
      {
        id: 'save-and-continue',
        title: 'Keep the placement and plan later edits',
        paragraphs: [
          'Apply flush fit saves the resulting transforms normally with the scene. Painted regions are temporary and reset when applying, canceling, or switching into or out of flush mode. Undo restores the previous placement.',
          'Use joints or retained plane constraints for relationships that must continue to govern later changes. After the fit, inspect the assembly from several angles and run interference inspection when physical clearance matters.',
        ],
      },
    ],
    related: ['contact-paint', 'planes', 'joints', 'no-clip'],
  },
  {
    id: 'anchors',
    title: 'Rigid anchor fitting',
    description:
      'Adjust several fixed targets together and see the residual gaps on imperfect scanned interfaces.',
    group: 'Build & assemble',
    icon: 'crosshair',
    intro:
      'Anchors provide fine control over a rigid part without changing its shape. Place attachment points on the part, then move their world-space targets. Every target participates equally in one best fit, letting you refine a join while seeing exactly where incompatible targets leave a gap.',
    image: {
      src: './images/anchors.webp',
      alt: 'Kitbasher rigid anchor controls showing the moving part, anchor targets, and fit gaps.',
      caption:
        'Select an anchor target to adjust it; the part is fitted against all retained targets.',
    },
    sections: [
      {
        id: 'create-anchors',
        title: 'Place attachment points around the interface',
        steps: [
          'Select a visible, unlocked moving part and choose Anchors in the toolbar, or press K.',
          'Choose Add anchors on surface.',
          'Click three points around the part’s interface. Spread them apart to describe the placement well.',
          'Choose Finish adding anchors.',
          'Select a numbered target in the viewport or the Fit anchors list.',
        ],
        paragraphs: [
          'One or two anchors also work. Where the selected points do not fully determine an orientation, the current orientation is retained as far as possible. Three well-spread points usually make the intended adjustment easier to understand than several nearly coincident anchors.',
        ],
      },
      {
        id: 'move-target',
        title: 'Adjust a target with handles or coordinates',
        paragraphs: [
          'Drag the selected target’s XYZ handle, or edit Anchor target X, Y, and Z in the inspector. Target numeric coordinates are always world millimeters, with 0.01 mm input steps. Handle axes follow the available World/Local setting, and snapping applies when enabled.',
          'Hold Shift while dragging for ten times finer movement. Moving one target keeps the other targets fixed; Kitbasher then recomputes the part’s rigid translation and rotation to minimize their combined gaps. Each drag is one undo step.',
        ],
      },
      {
        id: 'attachment-vs-target',
        title: 'Distinguish a target from the achieved attachment',
        paragraphs: [
          'Numbered circles mark target positions. Surface dots mark the attachment points after the part has moved, and lines connect each attachment to its target. Per-anchor millimeter values show the remaining distance; Fit gap reports their RMS.',
          'A reachable adjustment can pivot around other targets. If the targets cannot all be satisfied by one rigid body, the part reaches a compromise and the residual lines remain. Kitbasher never stretches the mesh to conceal that disagreement.',
        ],
        image: {
          src: './images/rigid-fit.svg',
          alt: 'Three target points and corresponding rigid-part attachment points, with lines showing residual gaps.',
          caption:
            'Targets remain fixed in world space; the achieved surface points reveal the residual fit.',
        },
      },
      {
        id: 'rebase',
        title: 'Use Hold current positions for another adjustment',
        paragraphs: [
          'Hold current positions sets every target to the part’s achieved attachment position. Use it when you are happy with the present pose and want a new adjustment to start from there, without carrying the old residual gaps forward.',
          'Other transform tools leave the world targets unchanged. After moving a part with Move or Rotate, return to Anchors and use Hold current positions when that new pose should become the baseline. Otherwise, the next anchor adjustment still tries to satisfy the earlier targets.',
        ],
      },
      {
        id: 'respect-relationships',
        title: 'Check joints, constraints, and collisions',
        paragraphs: [
          'Existing joints, locked parts, and retained plane constraints stay authoritative. No clip also influences anchor fits and target drags. If moving a target appears to have little effect, inspect the active connection, plane equations, and collision report before placing more targets.',
          'A residual can describe incompatible target geometry or a movement restriction. It is useful feedback about the setup. Compare per-anchor gaps and the visible join rather than treating a low overall RMS as proof that every interface is seated.',
        ],
      },
      {
        id: 'finish-and-save',
        title: 'Finish, remove, and preserve anchors',
        bullets: [
          'Press Esc to leave anchor editing while keeping anchors and adjustments.',
          'Remove an individual anchor with its remove button in the list.',
          'Anchor changes are undoable and anchors survive scene save, local recovery, and reopen.',
          'Reset Explode to zero before editing anchors. Hidden or locked moving parts cannot be edited.',
          'Use point alignment for known landmark pairs, contact paint for broad mating patches, and anchors for deliberate fine target adjustments.',
        ],
      },
    ],
    related: ['transforms', 'alignment', 'planes', 'no-clip'],
  },
  {
    id: 'joints',
    title: 'Joints & connected parts',
    description:
      'Create parent-child connections, choose hinge axes, and pose an assembly without separating its anchors.',
    group: 'Build & assemble',
    icon: 'link',
    intro:
      'A joint describes a connection between a moving child part and its parent. Connected anchors stay together as you pose the assembly, and per-axis rotation locks define the available motion. Use joints for hinges, fixed attachments, and groups of parts that should follow a parent.',
    image: {
      src: './images/joints.webp',
      alt: 'Kitbasher joint creation inspector with moving and target anchors, Keep connected, and axis locks.',
      caption:
        'Pick both anchors, then choose connectivity and rotational freedom before creating the joint.',
    },
    sections: [
      {
        id: 'create-joint',
        title: 'Connect two parts',
        steps: [
          'Select the moving part and choose Joint in the toolbar, or press J.',
          'Confirm the Moving part and the target part in the Joint anchors section.',
          'Pick the moving anchor on the child, then the matching anchor on the target parent.',
          'Choose Keep connected and the rotation axes to lock.',
          'Choose Create joint or press Enter.',
        ],
        paragraphs: [
          'A part can have one parent, and circular parent-child connections are prevented. Choose the target as the part that should drive the relationship. For example, an arm can be the child of a torso, and a hand can be the child of the arm.',
        ],
      },
      {
        id: 'rotation-freedom',
        title: 'Make a hinge or fixed attachment',
        paragraphs: [
          'Leave one rotation axis free for a hinge-like connection. Lock all three axes for a fixed joint. Locking a previously free axis captures the current pose, so position the part at the desired angle before locking it.',
          'Connected parts use joint axes for rotation controls, including numeric rotation. Rotation and scaling pivot around the joint anchor. A surface pivot can be useful for ordinary parts, but an active joint retains its connection anchor as the rotation pivot.',
        ],
      },
      {
        id: 'keep-connected',
        title: 'Choose whether the connection is active',
        table: {
          headers: ['Keep connected', 'Behavior'],
          rows: [
            [
              'On',
              'Anchors stay together. Rotation locks apply, and connected movement can carry other parts.',
            ],
            [
              'Off',
              'Parts move, rotate, and align independently while the stored anchors and lock settings are retained.',
            ],
            [
              'Turned back on',
              'The child is seated at its parent anchor in its current orientation.',
            ],
          ],
        },
        paragraphs: [
          'Change Keep connected when creating the joint or later in the child part’s Connections inspector. The toggle and transforms are undoable. A disconnected joint can preserve a useful connection definition while you perform independent placement.',
        ],
      },
      {
        id: 'assembly-motion',
        title: 'Predict which parts will follow',
        paragraphs: [
          'Moving a parent carries its active descendants. Translating a connected child can carry its connected assembly rather than pulling its anchor apart. A fixed connected part pins translation while free hinge rotation can remain available.',
          'Before moving a large connected model, inspect the connection structure and fixed locks. If you intend to adjust only one part independently, disconnect its relationship temporarily instead of trying to force a connected anchor away from its parent.',
        ],
      },
      {
        id: 'align-with-joints',
        title: 'Align a connected part',
        paragraphs: [
          'Alignment works while joints are active. It preserves connected anchors and rotation locks, holds the target stationary, and may move connected parts with the source. The displayed RMS describes the achieved fit, including these limits.',
          'A fixed anchor can make an exact requested fit impossible. Kitbasher labels that result constrained. Review which rotation axes remain free and whether the target can be reached with that freedom. Disconnecting is a deliberate change to the assembly relationship, not a requirement for every alignment.',
        ],
      },
      {
        id: 'collision-and-persistence',
        title: 'Check contact and save the editable assembly',
        paragraphs: [
          'Jointed parts may keep existing overlap around an anchor, as a ball must sit inside its socket, while No clip still stops the rest of the part at its parent. Creating a joint seats its anchors directly rather than applying the normal collision-placement check. Inspect the resulting join when clearance matters.',
          'Keep a .kitbash scene to preserve editable parts and their relationships. A geometry export is a separate delivery format; do not expect every exported model format to retain Kitbasher joint behavior.',
        ],
        note: {
          title: 'Use the right persistent relationship',
          text: 'Joints preserve point connections and rotational freedom. Retained plane constraints preserve planar offsets or angles. An anchor fit provides target-based placement without creating a parent-child joint.',
        },
      },
    ],
    related: ['transforms', 'alignment', 'planes', 'no-clip'],
  },
  {
    id: 'planes',
    title: 'Planes & persistent constraints',
    description:
      'Align to reference planes or retain mate, parallel, perpendicular, and angle relationships through later edits.',
    group: 'Build & assemble',
    icon: 'grid',
    intro:
      'Use a world reference plane for a one-time placement against the scene, or paint planar regions to define a relationship between parts. Retained plane constraints keep compatible offsets and angles active as you continue moving and posing the assembly.',
    image: {
      src: './images/alignment-methods.svg',
      alt: 'Point-to-plane and plane-to-plane diagrams showing a source point, target plane, and surface directions.',
      caption:
        'Planar relationships control distance, direction, or both, while leaving other movement free.',
    },
    sections: [
      {
        id: 'reference-plane',
        title: 'Use a world reference plane',
        paragraphs: [
          'Choose Align and a point or plane method. In Target part or plane, select a reference plane instead of another mesh. This provides a stable scene-level target when placing a base or organizing parts against a common orientation.',
          'The built-in planes are Ground · XZ, Front · XY, and Side · YZ. Their rows under Reference planes in the Parts panel let you toggle their visibility. They provide named world targets without adding an exported mesh.',
          'Point to plane moves a picked source point onto the target plane along its normal without changing rotation. Plane to plane also uses the moving face’s normal to orient the part. These picked alignments are one-time placement operations.',
        ],
      },
      {
        id: 'plane-methods',
        title: 'Choose a painted plane relationship',
        table: {
          headers: ['Relationship', 'What remains controlled'],
          rows: [
            [
              'Mate planes',
              'Normal direction and signed offset. Sliding within the plane and twisting around its normal remain free.',
            ],
            ['Parallel', 'Same or opposing normal directions, with position free.'],
            ['Perpendicular', 'A 90° angle between the plane normals, with position free.'],
            ['Angle', 'An explicit 0–180° angle between normals, with position free.'],
          ],
        },
        paragraphs: [
          'These relationships use planes fitted over the painted patches by triangle area, so a densely tessellated corner does not dominate just because it contains more triangles. Angle-only methods rotate around the painted moving patch rather than pulling patch centers together.',
        ],
      },
      {
        id: 'create-constraint',
        title: 'Create an active relationship',
        steps: [
          'Press B and choose the moving and target parts.',
          'Paint a matching pair of locally flat regions. One complete pair is sufficient for a plane relationship.',
          'Choose Mate planes, Parallel, Perpendicular, or Angle in Surface relationship.',
          'Set the Surface offset, normal direction, or Normal angle when that relationship exposes the option.',
          'Enable Keep constraint active.',
          'Choose Create plane constraints and review the achieved relationship.',
        ],
        paragraphs: [
          'Leave Keep constraint active off when you only want the current placement. Use a sufficiently wide, flat patch to define a stable plane. Extremely narrow or strongly curved patches may not define a unique plane and should be repainted.',
        ],
      },
      {
        id: 'edit-constraint',
        title: 'Manage relationships in the Constraints tab',
        paragraphs: [
          'The Constraints tab lists the moving and target parts and provides a name, relationship selector, Active switch, and residual readout. Rename a relationship to describe its purpose, change its type, or adjust the offset or angle directly.',
          'Mate and Parallel relationships expose Face direction for same or opposing normals. Suppress a constraint to place its moving part freely, then enable it again when the relationship should apply. Removing a constraint deletes that relationship; suppressing keeps its definition.',
        ],
      },
      {
        id: 'degrees-of-freedom',
        title: 'Combine compatible constraints',
        paragraphs: [
          'Targets drive moving parts. Multiple compatible plane equations can reduce the remaining movement freedom: one mate can keep a part seated while another relationship controls its tilt. Joints and fixed part locks also apply.',
          'A relationship constrains only what it describes. A single mate does not prevent sliding sideways, and an angle relationship does not fix translation. If a part can still move in an unexpected direction, check whether that degree of freedom is intentionally left open.',
        ],
      },
      {
        id: 'resolve-conflicts',
        title: 'Resolve incompatible or circular relationships',
        paragraphs: [
          'A conflicting or circular relationship produces an error and retains the previous scene. Do not add more constraints to overcome an existing conflict. Review the target direction, offset sign, active joints, and locks, then suppress or edit the relationship that contradicts the intended pose.',
          'Residual readouts show the achieved normal angle and, for a mate, distance. Retained constraints remain authoritative during later transforms and fits. Creating a joint or editing a kept constraint seats parts directly, so run interference inspection afterward when contact quality matters.',
        ],
      },
    ],
    related: ['alignment', 'contact-paint', 'flush-fit', 'joints'],
  },
  {
    id: 'no-clip',
    title: 'Avoid clipping',
    description:
      'Slide against neighboring surfaces, allow a controlled overlap, and understand collision sampling limits.',
    group: 'Build & assemble',
    icon: 'shield',
    intro:
      'No clip keeps parts from passing through other visible parts during placement. It is enabled by default and saved as a browser preference. Use it while assembling realistic interfaces, with a small allowed overlap when imperfect scans need to seat slightly inside one another.',
    image: {
      src: './images/transform.webp',
      alt: 'Kitbasher workbench with transform tools and the No clip controls in the toolbar.',
      caption:
        'No clip works with direct movement and fitting; the allowed overlap sets the contact tolerance.',
    },
    sections: [
      {
        id: 'enable-and-tolerance',
        title: 'Set a useful contact tolerance',
        steps: [
          'Keep No clip enabled in the toolbar while assembling against neighboring surfaces.',
          'Set Allowed overlap beside the toggle in millimeters.',
          'Use 0 for hard contact, or a small allowance for rough scans and snug sockets.',
          'Make the adjustment and read any placement note describing an obstruction or remaining overlap.',
        ],
        paragraphs: [
          'Allowed overlap defaults to 0.1 mm and can be raised up to 5 mm. Parts may sink into each other by that amount and no farther. Increase it only as much as the interface needs; a larger allowance is not a repair for incorrect scale or a poorly chosen fit.',
        ],
      },
      {
        id: 'dragging',
        title: 'Drag along surfaces',
        paragraphs: [
          'Move, Rotate, Scale, and anchor-target drags slide along encountered surfaces rather than simply pushing into them. Turning or scaling a part against a neighbor can shift it clear. On dense scans the part may trail the pointer briefly while contact is resolved, then settle when released.',
          'The movement check follows the path, helping prevent a fast gesture from jumping through a thin part. Fine contact still depends on the sampled features and tolerance, so inspect small or unusually thin details after placement.',
        ],
      },
      {
        id: 'typed-and-fit',
        title: 'Understand typed values and fitted placement',
        paragraphs: [
          'Typed transforms and point, plane, 3+ point, contact, flush, plane-relationship, and anchor fits seek the nearest placement to the request that remains clear. The preview, residuals, and RMS describe that achieved placement.',
          'A placement note explains how far the result shifted and which parts obstructed it. If the result differs from your requested numeric value, inspect that note, the active constraints, and the overlap setting before repeating the same request.',
        ],
      },
      {
        id: 'visibility-and-existing-overlap',
        title: 'Know which parts block movement',
        bullets: [
          'Every visible part is solid for No clip, including fixed parts.',
          'Hide a part when you need to work through it, such as a pile of freshly imported pieces.',
          'Isolation changes the view and does not remove the rest of the assembly from collision handling.',
          'Existing overlap is not forced apart by a drag or typed move. You can pull a part out, but cannot push it deeper.',
          'An alignment or anchor fit is treated as a fresh placement and can clear existing overlap.',
        ],
      },
      {
        id: 'joints-and-preparation',
        title: 'Account for joints and dense-mesh preparation',
        paragraphs: [
          'Jointed parts may retain overlap around their anchor so a socket or ball can still pose. The rest of the part stops against its parent. Joints, fixed locks, and retained plane constraints remain authoritative; when they require overlap, the result reports it.',
          'Creating a joint or editing a retained constraint seats parts directly without the ordinary collision check. Large meshes join precise contact handling once their surface indexes are prepared. While a nearby dense mesh is still preparing, a move can be held at its current position; movement in open space remains available. Retry the held move after preparation finishes.',
        ],
      },
      {
        id: 'limitations',
        title: 'Inspect the final fit',
        paragraphs: [
          'Contact checks use approximately 3,000 evenly spread original-surface samples per part, plus coarse-mesh edges. During a dense drag a smaller set of roughly 256 samples reduces the work, and releasing checks the placement with the full set. Features much finer than the sample spacing or thinner than twice the allowed overlap can evade detection.',
          'Open scans block from both sides except very near an open rim. No clip is a placement aid, not a final geometry guarantee. Use interference inspection to assess exact solid overlap volume where closed, consistently wound geometry supports it, and examine the actual joins from several angles.',
        ],
      },
    ],
    related: ['transforms', 'alignment', 'anchors', 'joints'],
  },
  {
    id: 'measurement',
    title: 'Measure & read point markers',
    description:
      'Measure point-to-point distances and keep alignment, anchor, pivot, and joint markers readable.',
    group: 'Inspect & finish',
    icon: 'ruler',
    intro:
      'The Measure tool reads the straight-line distance between two picked mesh-surface points in millimeters. Use it to inspect a gap, compare recognizable landmarks, or check the scale of an imported part. Shared marker preferences keep picked points and fitting targets legible as you zoom.',
    image: {
      src: './images/measurement.webp',
      alt: 'Kitbasher Measure tool with two picked surface points and their distance shown in millimeters.',
      caption:
        'The Measure tool reports the distance between two picked surface points in millimeters.',
    },
    sections: [
      {
        id: 'take-measurement',
        title: 'Measure between two surface points',
        steps: [
          'Choose the Measure distance tool in the toolbar, or press D.',
          'Click the first surface point on a mesh.',
          'Click the second surface point. The viewport prompt shows the distance in millimeters to three decimal places.',
          'Click again to begin another measurement. Press Esc when you want to leave the tool.',
        ],
        paragraphs: [
          'The points can be on the same part or on different parts. Frame and orient the relevant region before clicking so each pick lands on the intended surface rather than a closer object in front of it.',
        ],
      },
      {
        id: 'what-distance-means',
        title: 'Know what the value represents',
        paragraphs: [
          'The result is the direct spatial distance between the two picked points. It is not a path length over the surface, a wall-thickness analysis, or an automatic minimum clearance between entire parts.',
          'For a deliberate landmark-to-landmark comparison, pick the same identifiable features each time. To inspect the nearest region between two parts, use interference inspection and its Closest-point markers. Contact RMS and anchor gaps describe fitting residuals and should be read in that fitting context.',
        ],
      },
      {
        id: 'accurate-picks',
        title: 'Expose the point you want to inspect',
        paragraphs: [
          'Orbit to see the surface clearly, and use framing or orthographic views when they make the geometry easier to read. Temporary isolation removes visual clutter without changing saved visibility. With Nearby surfaces, the surrounding contact region remains pickable where it is actually drawn.',
          'Exploded view separates the parts visually. Reset it before measuring an assembled join. On dense scans, wait for background surface preparation to finish before relying on viewport picking; display proxies do not replace the authoritative original geometry used for surface tools.',
        ],
      },
      {
        id: 'marker-size',
        title: 'Adjust point and label size',
        paragraphs: [
          'Open Preferences and find Point markers. Point size and Label size are measured in screen pixels, so markers keep a consistent visible size at any zoom.',
          'These preferences apply to anchors, pivots, picked surface points, measurements, joints, and painted patches. Increase marker size when precise points are difficult to see, or reduce it when nearby markers obscure a small interface.',
        ],
      },
      {
        id: 'callouts',
        title: 'Move labels clear of the model',
        steps: [
          'In Point markers, change Labels from Beside point to Callout.',
          'Choose Clear of model to position labels above the model’s outline, or Fixed leader for a chosen line length.',
          'Adjust Clearance above model or Leader length in pixels.',
          'Review the preference panel’s marker preview, then inspect the actual interface at your working zoom.',
        ],
        paragraphs: [
          'Callout leaders run straight above their points on screen. Labels that would overlap stack outward, helping keep several source/target or anchor labels readable. These are marker-display preferences; they do not create additional constraints or change the measured geometry.',
        ],
      },
      {
        id: 'interpret-fit-markers',
        title: 'Read the other fitting markers',
        bullets: [
          'Alignment pairs identify source and target picks, making it possible to review or remove a mistaken correspondence.',
          'Anchor target circles and attachment dots are separate positions. Their connecting lines show the remaining rigid-fit gap.',
          'A custom pivot marker identifies the selected part’s rotation, scale, and orbit point; an active joint keeps its own anchor behavior.',
          'Painted patch markers identify the numbered fitting regions. Check both members of a pair when a fit behaves unexpectedly.',
        ],
        note: {
          title: 'Visible precision and geometric certainty differ',
          text: 'A result displayed to 0.001 mm does not mean a rough scan or a hand-picked landmark is accurate to that amount. Judge the source geometry, pick location, and remaining residuals together.',
        },
      },
    ],
    related: ['alignment', 'anchors', 'transforms', 'no-clip'],
  },
];
