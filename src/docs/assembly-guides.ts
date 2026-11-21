import type { DocArticle } from './types';
import { referenceImages } from './reference-images';

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
        image: referenceImages.precisionControls,
        tutorials: ['tutorial-precision'],
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
    related: ['tutorial-precision', 'alignment', 'pins', 'anchors', 'joints', 'no-clip'],
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
        tutorials: [
          'tutorial-point-to-point',
          'tutorial-point-to-plane',
          'tutorial-plane-to-plane',
        ],
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
        tutorials: ['tutorial-multi-point'],
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
    related: [
      'alignment-tutorials',
      'tutorial-point-to-point',
      'tutorial-point-to-plane',
      'tutorial-plane-to-plane',
      'tutorial-multi-point',
      'contact-paint',
      'planes',
      'anchors',
      'no-clip',
    ],
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
        tutorials: ['tutorial-contact'],
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
        image: referenceImages.brushSettings,
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
    related: ['tutorial-contact', 'alignment', 'flush-fit', 'planes', 'no-clip'],
  },
  {
    id: 'refine',
    title: 'Refine edges and surfaces on a scan',
    description:
      'Rebuild softened edges, clean up painted areas, and review proposed fixes on a scanned part.',
    group: 'Build & assemble',
    icon: 'zap',
    intro:
      'A scan of a small part often rounds off edges that should be sharp and leaves ripples on faces that should be flat or round. Refine rebuilds an edge from a guide you lay along it, treats a painted area so it is smooth, flat or a true shape and can keep rivets and other detail, and offers brushes for local fixes. Review a selected guide or region on the part, accept the ones you want, and choose Apply to save the session’s working surface to the part.',
    image: referenceImages.refine,
    sections: [
      {
        id: 'start',
        title: 'Start a Refine session',
        paragraphs: [
          'Refine works on one part at a time. Until you choose Apply, its changes stay in the session and the part itself is unchanged.',
        ],
        steps: [
          'Select one visible, unlocked part and press E, or choose Refine (the sparkles button) in the toolbar.',
          'Wait while the panel shows Preparing the surface…',
          'Choose a mode: Edge, Region, Brush, or Detect.',
        ],
        note: {
          title: 'What the settings change',
          text: 'Feature settings edit selected pending guides in Edge or selected pending regions in Region. With no matching pending selection, they set the defaults for the next feature. Different values show Mixed. If treatments differ, no Treatment option is selected. The line above Cancel and Apply, such as 1 accepted · 1 proposed, counts what the session holds.',
        },
      },
      {
        id: 'guide-an-edge',
        title: 'Guide an edge',
        paragraphs: [
          'A guide marks a softened edge for the tool to rebuild. Lay it along the rounding itself or close beside it.',
        ],
        steps: [
          'In Edge mode, choose Line, Arc, or Spline under Guide.',
          'Click points on the rounded edge. A line takes two points and an arc three. For a spline, place at least two points, then press Enter to finish it.',
          'Review the preview while the guide is selected. The solved edge is dashed, and the area the guide affects is tinted.',
          'Press Enter or choose Accept to keep the edge, or choose Dismiss to discard it. Accept keeps the change in this session, and the edge is then drawn along the mesh edges that were cut. The preview shows the fit, not the cut. If the edge was cut in more than one piece, the breaks are marked and the panel says so, for example The edge was cut in 3 pieces. Undo to adjust the guide, or keep it.',
          'Choose Apply to save the accepted changes to the part.',
        ],
        note: {
          title: 'When no edge is found',
          text: 'The tool shows No edge found under this guide. Move it onto the rounded edge or change Width. The guide stays in the session so you can move its points or change Width. If the panel warns that triangles fold over, undo the last step or reduce Width. A very long spline on a fine mesh is refused with This guide is too long for this mesh. Try a shorter guide. Accept leaves a guide or region pending when it would change nothing, for example at 0 % strength, and says so.',
        },
      },
      {
        id: 'adjust-a-guide',
        title: 'Shape and adjust a guide',
        paragraphs: [
          'With one open pending guide selected, finish its current segment, pressing Enter for a spline. Click farther along the edge to start the next segment. Guide and Joints set how the next segment is drawn. The panel shows Applies to the next segment. Joints sets whether each new joint is Sharp, a corner, or Smooth.',
          'Click the first handle of the selected open guide to close it. A single line cannot close. A three-point arc can close directly, and a spline you are still drawing can close after three points. On a multi-segment path, the starting point can finish the segment you are still drawing. If Refine needs to add a closing segment to a finished path, choose Line or Spline under Guide. Press Esc while placing an unfinished guide to discard it.',
          'Drag the points of a selected guide along the surface to adjust it. The preview updates when the pointer rests and when you let go, and Accept waits for it. Each completed drag that moves a handle is one undo step. Click a point of a selected guide to choose it; the chosen point is highlighted. Clicking the first point of an open guide that can close closes it instead. Remove point, Delete, or Backspace removes the chosen point when the guide stays complete, as one undo step. Remove point is in the Edge panel, and in Detect while a point is chosen. Choosing a point needs the pointer. Esc clears the choice first. With no point chosen, Delete dismisses the guide. Width is measured from the edge the tool finds, not from the guide. Automatic width lets the tool estimate how far to either side of that edge it reads and rebuilds the surface, up to 1 mm unless the edge cannot be read within 1 mm. Turn it off to set Width yourself. Strength sets how loosely the edge follows the guide’s line, arc or spline, from no change to fully on it.',
          'Ends sets Start and End separately for an open guide; the larger point marks the start. Choose Hold when Auto fades an edge that should run sharp into a corner, and Fade when Auto holds one that should die away.',
        ],
        table: {
          headers: ['Ends', 'Effect'],
          rows: [
            [
              'Auto',
              'The tool chooses Fade or Hold for that end. When one selected guide has a fit, it names its choice, such as Auto (Fade).',
            ],
            ['Fade', 'Tapers the sharpness out along the edge toward that end.'],
            ['Hold', 'Keeps the edge sharp to the end of the guide.'],
          ],
        },
      },
      {
        id: 'treat-a-region',
        title: 'Treat a painted region',
        paragraphs: [
          'A region cleans up an area you paint: it smooths it, flattens it, or snaps it to a shape.',
        ],
        steps: [
          'In Region mode, paint the area to treat. Hold Alt or choose Erase to remove paint; [ and ] shrink or grow the brush.',
          'Choose Make region.',
          'Choose a Treatment: Smooth, Flatten, or Shape.',
          'Adjust Strength, Keep detail, and Blend, then review the preview. To set Blend, turn off Automatic blend.',
          'Choose Accept, or Dismiss.',
        ],
        note: {
          title: 'When the area is too small',
          text: 'The tool shows This area is too small to fit a surface. Paint more of it. Painting more does not enlarge a region you have made: dismiss it, paint the larger area, and choose Make region again. With Sweep, this notice also appears when Sweep cannot fit the selected surface.',
        },
      },
      {
        id: 'region-settings',
        title: 'Choose a treatment and keep detail',
        paragraphs: [
          'Strength sets how loosely the area follows the treatment, from no change to fully on it. Keep detail is on by default, and the raised and recessed details it will keep in the selected region are outlined. Offset sets how far a feature must deviate from the surface, raised or recessed, to be preserved. If the outline misses shallow engraving or low rivets, turn off Automatic offset and lower Offset.',
          'Blend sets how wide the transition at the region’s border is.',
        ],
        table: {
          headers: ['Treatment', 'Result'],
          rows: [
            [
              'Smooth',
              'Smooths ripples while following the surface’s curvature. Reach sets the longest ripple it removes: raise it for long waves, and leave Automatic reach on otherwise.',
            ],
            ['Flatten', 'Fits the area toward a true plane.'],
            [
              'Shape',
              'Choose Cylinder, Cone, or Sphere to set the shape, or Auto to let the tool choose. Auto can also choose a plane. For one selected region with a fit, the panel names it, for example Fits a cylinder.',
            ],
            [
              'Shape → Sweep',
              'Fits the area toward a constant cross-section carried along a curve, for pipes and hoses. Choose it yourself: Auto never picks it. It can refuse a tube whose cross-section swells or tapers.',
            ],
          ],
        },
      },
      {
        id: 'brushes',
        title: 'Use the brushes',
        paragraphs: [
          'In Brush mode, choose Crease, Flatten, or Smooth, set Brush radius and Strength, and drag across the surface. [ and ] shrink or grow the brush. Brushes and paint act only on the surface in front of you.',
          'Drag Crease along the rounding. Crease sharpens on release if it can fit the edge within the brush width. If the edge needs a wider fit, Refine leaves a selected pending guide and shows The edge is wider than the brush. Check the preview, then accept it. In Brush mode, choose Accept or press Enter to keep the change. Choose Dismiss or press Delete to remove the guide. Press Esc to deselect it and keep it pending. If the stroke finds no edge, the tool shows the no-edge notice and nothing changes.',
          'Flatten flattens the surface under the brush, and Smooth smooths it; edges the tool has rebuilt are held. A stroke that changes the surface is one step you can undo within the session. A stroke that finds nothing adds no step. A wide Crease stroke that leaves a pending guide adds one session undo step.',
        ],
      },
      {
        id: 'detect',
        title: 'Let Refine propose',
        paragraphs: [
          'Detect looks for softened edges and surfaces and proposes guides and regions for you to review. New proposals are drawn on the part: edges as dashed guides and surfaces as tinted regions with a treatment already chosen.',
        ],
        steps: [
          'In Detect mode, choose Whole part or Painted area under Look in. For Painted area, paint where to look.',
          'Set Sensitivity: higher values admit softer, more rounded edges. Raise Minimum length to leave out shorter edges, such as small rivet outlines.',
          'Choose Find edges and surfaces. Progress shows in the panel, and the Cancel button below it stops the search.',
          'Click a proposal to select it, or Shift-click to add it to the selection or remove it. Select all proposed selects every pending guide and region.',
          'To change a proposal’s settings, select it here, then switch to Edge for a guide or Region for a region.',
          'In Detect, choose Accept selected or Dismiss selected. In Edge or Region, choose Accept or Dismiss for the selected features of that mode.',
        ],
        note: {
          title: 'Previewing and keeping proposals',
          text: 'Select a pending proposal to preview its fit on the part. With more than 8 pending proposals selected, the preview is off. In Detect the panel says Preview is off while more than 8 are selected. Accepting still works. Accept selected keeps the changes that fit in the session’s working surface as one undo step. Each press of Accept or Accept selected shows at most one notice. Apply saves the working surface to the part. A completed search replaces untouched pending proposals from Detect. It keeps accepted features, edited proposals and guides or regions you made. It skips edges and regions those features already mostly cover.',
        },
      },
      {
        id: 'apply-or-cancel',
        title: 'Apply or cancel',
        paragraphs: [
          'While the tool is open, Ctrl/⌘ + Z and Ctrl/⌘ + Shift + Z undo and redo session steps, such as placing or dragging guide points, painting, accepting, and strokes that change the surface. These shortcuts use session history first. Changing a setting is not a step. Pressing Esc, or switching to another window, during a brush stroke or a drag of a guide point discards that stroke or drag, leaving nothing to undo.',
          'Apply saves the working surface to the part as one undo step in the scene. It becomes available once you have accepted a feature or made a stroke that changed the surface. Pins, anchors, joints, and other parts are not modified, and Refine stays open so you can continue.',
          'Cancel discards the work you have not applied and leaves the tool. When Esc has nothing else to end, such as a stroke, a drag, an unfinished guide, or a waiting Crease guide, it returns to Select, unless the session holds work. Then Esc stays in Refine and the status line shows Apply to keep your changes, or Cancel to discard them. Leaving Refine another way, such as choosing another tool, discards this session. If you leave that way while the session holds work you made, such as accepted changes, guides you drew, proposals you edited, or paint, the app shows Refinement discarded. Use Apply to keep it. Cancel shows no notice. Changes you applied earlier stay on the part.',
        ],
      },
      {
        id: 'good-results',
        title: 'Getting good results',
        bullets: [
          'Restore edges before smoothing or flattening across them. Smoothing or flattening across an edge that has not been rebuilt can soften it further; rebuilt edges are held.',
          'On a plate with rivets, use a painted region with Flatten and Keep detail rather than the Flatten brush. The brush can flatten rivets, and clipping one can leave a step at its rim.',
          'A guide needs surface on both sides to work with. Lay it along the rounded edge itself or close beside it. A line laid along an edge that curves follows the curve. If the tool says no edge was found, move the guide onto the rounding or change Width. A lip or rib rounded right over, with no flat top left, has no edge for the tool to find.',
          'Where three faces meet, in a pocket or at a box corner, guide the edges separately if a path through the corner leaves a mark there.',
          'Treat proposals as a starting point. Check them before accepting many at once. Where Detect proposes a guide on a smooth tube or across a scan dent, dismiss it.',
          'Small hardware such as clips, flanges, and buckle lips is often shorter than Minimum length. Lower it to pick those up, and expect more short guides to check.',
          'Detect finds plates, domes, and barrels it can see whole. Paint hoses, and any area Detect misses or splits, such as a surface crossed by straps or belts, by hand in sections.',
          'Apply a Sweep once over an area. Re-applying the same Sweep to the same area can shift the surface slightly each time. If Keep detail outlines irregularities you want Sweep to remove, turn it off and compare the preview.',
          'If a proposal or handle on the far side of the part or behind another part will not respond, turn the view so it faces you: only what is visible can be picked.',
          'A very large painted region can take a moment to preview after each change.',
          'After you accept an edge on a very large part, the cursor can briefly show busy while Refine prepares the surface for picking. Wait before starting a brush stroke, painting a region, or dragging a handle. Single clicks to place points or select proposals still work.',
        ],
      },
    ],
    related: ['contact-paint', 'parts', 'inspection', 'keyboard-shortcuts'],
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
        tutorials: ['tutorial-flush'],
        steps: [
          'Select the moving part and press B to open Contact paint.',
          'Under Surface relationship, choose Paint flush · across seams.',
          'Drag from a small outer surface on the moving part, across the gap, and onto its stationary neighbor. The stroke paints both sides automatically.',
          'With the moving part chosen, strokes can also start on a neighbor. Repaint either side to extend the region, or use Alt / Erase and stroke undo to revise it.',
          'Inspect the cyan preview, height error, and tilt error.',
          'Choose Apply flush fit to commit one undoable edit.',
        ],
        paragraphs: [
          'In Full scene or Isolate both parts, a stroke can paint both sides without a separate target stage. In Active part only or Ghost other part, paint the moving side, choose Next: paint target, paint the target, then Finish pair. One complete seam is sufficient; add more seams when several connections should remain aligned together.',
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
    related: ['tutorial-flush', 'contact-paint', 'planes', 'joints', 'no-clip'],
  },
  {
    id: 'pins',
    title: 'Pins and soft pins',
    description: 'Hold surface points in space or add elastic resistance with adjustable priority.',
    group: 'Build & assemble',
    icon: 'pin',
    intro:
      'Pins resist movement while you position a rigid part. Hard pins fix an exact point in world space; soft pins act like rubber bands of different strengths. The mesh keeps its shape.',
    image: {
      src: './images/pins.webp',
      alt: 'Kitbasher Pin tool with an isolated torso rotated around the orange P1 hard pin and the fixed-point controls visible.',
      caption:
        'A hard pin holds P1 in world space while the torso rotates around it. The Pins panel shows the fixed point and controls to reset or remove it.',
    },
    sections: [
      {
        id: 'place-pins',
        title: 'Place pins on a part',
        tutorials: ['tutorial-hard-pins'],
        steps: [
          'Select a visible, unlocked part and choose Pin in the toolbar.',
          'Choose Pin for a hard pin or Soft pin for elastic resistance.',
          'Click the selected part’s surface to place one or more pins, then choose Finish placing pins.',
          'Use Move, Rotate, Transform, or numeric adjustments. Pins stay active after leaving the Pin tool.',
        ],
        paragraphs: [
          'One hard pin allows rotation around its point. Two distinct hard pins leave rotation around their shared axis. Three noncollinear hard pins hold the complete pose. Existing joints, locks, and plane constraints still apply; conflicting hard pins block a placement.',
        ],
      },
      {
        id: 'soft-priority',
        title: 'Adjust soft-pin priority',
        tutorials: ['tutorial-soft-pins'],
        paragraphs: [
          'Select a soft pin in the viewport or Pins list. Set Priority using the slider or numeric field, from 0 (free) to 100 (strongest). Resistance rises exponentially across this range, so stronger pins give less while weaker pins stretch farther.',
          'Orange P markers show hard pins. Teal S markers show soft-pin resting points, with lines to their current surface attachments. The Pins panel reports the stretch in millimeters.',
          'The part stays where you release it. Resting points remain fixed, so later movements still feel their resistance. This is a positioning aid; it does not animate a spring returning to rest.',
        ],
        image: {
          src: './images/soft-pins.webp',
          alt: 'Two soft pins on the rotated torso: priority 85 has 0.03 mm of stretch, priority 15 has 8.86 mm, with the priority slider, numeric field, and teal stretch line visible.',
          caption:
            'In this example, S1 at priority 85 stretches only 0.03 mm, while S2 at priority 15 gives 8.86 mm. Select a pin to change its priority with the slider or numeric field.',
        },
      },
      {
        id: 'manage-pins',
        title: 'Reset, remove, and save',
        bullets: [
          'Reset resting points places all the selected part’s targets at their current attachments.',
          'Switching a stretched soft pin to hard locks its current attachment without moving the part.',
          'Remove an individual pin with its trash button. A soft pin at priority 0 exerts no resistance.',
          'Pin edits and movement support undo/redo. Pins survive scene save, recovery, reopen, and shared editing. Copies receive independent pins at the copied position.',
          'Reset Explode to zero and choose a visible, unlocked part before editing pins.',
        ],
      },
    ],
    related: [
      'tutorial-hard-pins',
      'tutorial-soft-pins',
      'transforms',
      'anchors',
      'joints',
      'planes',
    ],
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
        tutorials: ['tutorial-anchors'],
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
    related: ['tutorial-anchors', 'transforms', 'alignment', 'planes', 'no-clip'],
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
        tutorials: ['tutorial-joints'],
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
    related: ['tutorial-joints', 'transforms', 'alignment', 'planes', 'no-clip'],
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
        image: referenceImages.referencePlane,
        paragraphs: [
          'Choose Align and a point or plane method. In Target part or plane, select a reference plane instead of another mesh. This provides a stable scene-level target when placing a base or organizing parts against a common orientation.',
          'The built-in planes are Ground · XZ, Front · XY, and Side · YZ. Their rows under Reference planes in the Parts panel let you toggle their visibility. They provide named world targets without adding an exported mesh.',
          'Point to plane moves a picked source point onto the target plane along its normal without changing rotation. Plane to plane also uses the moving face’s normal to orient the part. These picked alignments are one-time placement operations.',
        ],
      },
      {
        id: 'plane-methods',
        title: 'Choose a painted plane relationship',
        tutorials: [
          'tutorial-mate',
          'tutorial-parallel',
          'tutorial-perpendicular',
          'tutorial-angle',
        ],
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
        image: {
          src: './images/tutorials/mate-5.webp',
          width: 1440,
          height: 1000,
          alt: 'Constraints tab with an active Mate planes relationship between Moving block and Target block, showing offset, face direction, and residual.',
          caption:
            'The Mate planes practice scene after creation: edit the relationship in the Constraints tab on the left and read its achieved residual.',
        },
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
    related: [
      'tutorial-mate',
      'tutorial-parallel',
      'tutorial-perpendicular',
      'tutorial-angle',
      'alignment',
      'contact-paint',
      'flush-fit',
      'joints',
    ],
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
        image: referenceImages.placementSettings,
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
        title: 'Use compact callouts',
        image: referenceImages.markerPreferences,
        steps: [
          'In Point markers, change Labels from Beside point to Callout.',
          'Use Label spacing to set a short gap between each point and its label.',
          'Orbit and zoom: labels follow their points, keeping their local position unless a nearby label or viewport edge needs room.',
          'Review the preference panel’s marker preview, then inspect the actual interface at your working zoom.',
        ],
        paragraphs: [
          'Callouts use compact dark badges with light text, a subtle edge, and a short thin connector to the point. Crowded labels adjust locally rather than moving to the edge of the model. Selected pins and anchors have a subtle colored edge, and labels stay readable while navigating. These display preferences do not create additional constraints or change the measured geometry.',
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
