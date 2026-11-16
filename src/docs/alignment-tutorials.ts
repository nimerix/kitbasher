import type { DocArticle, DocSection } from './types';

type Step = { title: string; paragraphs: string[]; caption: string; tip?: string };

function tutorial(
  slug: string,
  title: string,
  description: string,
  intro: string,
  icon: string,
  steps: Step[],
  related: string[],
): DocArticle {
  return {
    id: `tutorial-${slug}`,
    title,
    description,
    intro: `${intro} Download the practice scene below and open it with File → Open scene. The orange Moving block is the part you adjust; the teal Target block is the reference. These original block models make the relationship easy to see before trying the same workflow on a miniature. Save your own assembly before opening a practice scene. Shortcuts below use the default bindings.`,
    group: 'Alignment tutorials',
    icon,
    practiceScene: `./examples/${slug}.kitbash`,
    animation: {
      src: `./animations/${slug}.mp4`,
      poster: `./images/tutorials/${slug}-1.webp`,
      captions: `./animations/${slug}.vtt`,
      title: `${title}: animated walkthrough`,
    },
    sections: steps.map((step, index): DocSection => ({
      id: `step-${index + 1}`,
      title: `${index + 1}. ${step.title}`,
      paragraphs: step.paragraphs,
      image: {
        src: `./images/tutorials/${slug}-${index + 1}.webp`,
        alt: `${title}, step ${index + 1}: ${step.caption}`,
        caption: step.caption,
      },
      ...(step.tip ? { note: { title: 'Check before continuing', text: step.tip } } : {}),
    })),
    related,
  };
}

const pointToPoint = tutorial(
  'point-to-point',
  'Point to point: match a landmark',
  'Translate one picked surface point to another, with optional clearance.',
  'Use Point to point for coarse seating when you already like the part’s orientation. It translates the moving part without solving its rotation. In this exercise you bring the center of the orange block’s right face toward the center of the teal block’s left face.',
  'align',
  [
    {
      title: 'Choose the moving part and method',
      paragraphs: [
        'Select Moving block in Parts, press A, and choose Point to point under Alignment method. Set Moving part to Moving block and Target part or plane to Target block. The source is the part that moves; the target stays in place during this fit.',
        'Reset Explode to zero and make both parts visible. Leave No clip on with the default 0.1 mm allowance for this exercise. If the scene is crowded, choose Isolate both parts under Alignment view. Changing the moving or target part clears the current picks, so set these first.',
      ],
      caption:
        'Point to point is selected, with Moving block and Target block assigned before any picks.',
    },
    {
      title: 'Pick the source landmark',
      paragraphs: [
        'Click near the center of the orange block’s right-hand face, the face looking into the gap. A source marker appears and the prompt changes to Now click the matching target surface. The block has not moved yet.',
        'On a miniature, choose an identifiable feature such as the center of a peg or an interface corner. Middle-drag or Space + left-drag orbits while keeping the pick. Right-drag pans; the wheel zooms. Avoid clicking a surface in front of the landmark you intended.',
      ],
      caption: 'S1 marks the source point; the inspector is waiting for its matching target.',
    },
    {
      title: 'Pick the matching target',
      paragraphs: [
        'Orbit until you can see the teal block’s left-hand face and click its center. T1 appears and Surface pair lists one completed source–target pair. Apply alignment becomes available.',
        'Review both markers. If either pick is wrong, use Reset to clear the pair and repeat source then target. Selecting another spot without resetting does not replace an already completed single pair.',
      ],
      caption: 'S1 and T1 form one complete Surface pair, and Apply alignment is enabled.',
    },
    {
      title: 'Set clearance and read the collision note',
      paragraphs: [
        'In Alignment options, set Surface offset to 0.5 mm. This shifts the requested destination along the target face’s outward normal. Here the target’s left face points toward the gap. Use 0 when the picked points should coincide exactly, subject to active constraints and collision handling.',
        'The practice blocks start at different angles. Translating the picked point can push another corner into the target, so No clip can move the result away from the exact request. Read the Avoid clipping note. Point to point intentionally leaves this tilt unchanged; Plane to plane or 3+ point fit can correct it.',
      ],
      caption:
        'A 0.5 mm Surface offset adds outward clearance; the inspector also reports any collision adjustment.',
    },
    {
      title: 'Apply and inspect the unchanged orientation',
      paragraphs: [
        'Click Apply alignment or press Enter. The tool returns to selection and the orange block moves toward the teal block. Orbit around the join: its original tilt remains, and the achieved point match may have a gap where No clip kept a corner clear.',
        'Use Ctrl/⌘ + Z to undo an unwanted placement. For a real assembly, check the opposite side and run Interference before saving. Save scene preserves the new placement; this one-time point pair does not become a lasting relationship.',
      ],
      caption:
        'The moving block has translated toward the target while retaining its starting tilt.',
    },
  ],
  ['alignment', 'tutorial-plane-to-plane', 'tutorial-multi-point', 'no-clip'],
);

const pointToPlane = tutorial(
  'point-to-plane',
  'Point to plane: reach a support plane',
  'Project a chosen point onto a part face or world reference plane without changing rotation.',
  'Use Point to plane when height or distance from a plane matters but sideways placement should stay unchanged. This exercise brings a point on the orange block’s underside to Ground · XZ. It does not level the entire underside.',
  'align',
  [
    {
      title: 'Choose Ground as the target',
      paragraphs: [
        'Select Moving block, press A, and choose Point to plane. In Target part or plane, select Ground · XZ. In the left panel’s Reference planes, click Ground · XZ to make the plane visible if its eye is crossed out.',
        'The ground is the XZ plane at world Y = 0. Front · XY lies at Z = 0, and Side · YZ lies at X = 0. You can instead select another part and pick a flat face on it. Focused two-part alignment views are unavailable for a world reference plane.',
      ],
      caption: 'Point to plane targets the visible Ground · XZ reference plane.',
    },
    {
      title: 'Pick the point whose height you want to set',
      paragraphs: [
        'Orbit below the orange block and click near the center of its bottom face. This is the source point whose perpendicular distance to the ground will be removed. The source face’s own normal does not rotate the part in this method.',
        'Use a foot’s lowest contact point or a specific mounting point on your own model. A center point on a tilted underside is a useful demonstration, but it is not necessarily the lowest point of that part.',
      ],
      caption:
        'The source point is on the moving block’s underside; the ground remains the target.',
    },
    {
      title: 'Pick anywhere on the intended plane',
      paragraphs: [
        'Click the visible ground plane. The target point and its normal define the plane used for projection. You do not need to click exactly below the source: the source travels along the plane normal, not along the line between the two clicked positions.',
        'If you use a target part instead, pick the correct flat face. On a rough scan, one triangle can have an unrepresentative normal; use a painted Mate planes relationship when you need a plane estimated over a wider surface.',
      ],
      caption: 'A complete pair links the underside source point to Ground · XZ.',
    },
    {
      title: 'Set the required height',
      paragraphs: [
        'Set Surface offset to 0 mm to bring the source point to the plane. A positive offset on Ground raises that point above Y = 0; for example 1 mm requests a 1 mm stand-off. On a part face, the sign follows that face’s normal rather than world up.',
        'Check that the target really is Ground and that the orange part is unlocked. Only the component of translation normal to the target plane is solved. Sideways translation and the part’s rotation are not corrected by this operation.',
      ],
      caption:
        'Surface offset is zero, requesting that the selected source point reaches ground height.',
    },
    {
      title: 'Apply and check the whole underside',
      paragraphs: [
        'Click Apply alignment. The orange block moves down without leveling itself; the teal reference block stays where it was. Orbit below or choose a side view to inspect which corners extend below the plane.',
        'A world reference plane is a picking aid, not a solid collision obstacle. A tilted block can pass through it even with No clip on. If the whole base must lie flat, undo and use Plane to plane against Ground, choosing opposing normals for a downward-facing underside against the upward ground normal. Save once the intended support is verified.',
      ],
      caption:
        'The chosen underside point reaches Ground while the moving block keeps its tilt and sideways position.',
    },
  ],
  ['tutorial-plane-to-plane', 'tutorial-mate', 'alignment', 'no-clip'],
);

const planeToPlane = tutorial(
  'plane-to-plane',
  'Plane to plane: seat two faces',
  'Orient picked face normals and bring the selected face points together.',
  'Use Plane to plane for flat mating interfaces such as a mounting face against a bracket. Unlike Point to plane, it rotates the moving part and seats the picked points. This exercise joins the right face of the orange block to the left face of the teal block.',
  'align',
  [
    {
      title: 'Select the two parts and plane method',
      paragraphs: [
        'Select Moving block, press A, and choose Plane to plane. Confirm Moving block as Moving part and Target block as Target part or plane. Keep Explode at zero and both parts visible.',
        'A picked plane comes from the clicked surface triangle and its normal. Look for a flat region rather than a bevel. For noisy scans, the painted Mate planes tutorial shows how to estimate each plane from many triangles.',
      ],
      caption: 'Plane to plane is active for the orange moving block and teal target block.',
    },
    {
      title: 'Pick the moving face',
      paragraphs: [
        'Click the center of the orange block’s right face, looking into the gap. S1 records both the surface point and its face direction. The final result will seat this specific point, so its position on the face matters as well as the face normal.',
        'Hold Space while dragging to orbit to a clear view. Avoid rounded edges, where adjacent triangles can have different normals. If you accidentally pick a bevel, reset and use the broad face.',
      ],
      caption: 'The source pick is centered on the moving block’s flat right face.',
    },
    {
      title: 'Pick the stationary mating face',
      paragraphs: [
        'Orbit to expose the teal block’s left face and click its center. Surface pair now has a completed source and target. These points specify where the faces meet; the normals specify their relative orientation.',
        'For a base on the ground, select Ground · XZ as the target instead, make that reference plane visible in the left panel, pick the base’s underside, then click the ground at the desired seating location.',
      ],
      caption: 'The completed pair joins the two inward-facing flat surfaces.',
    },
    {
      title: 'Choose opposing normals and an offset',
      paragraphs: [
        'Leave Opposing face normals on for this exercise: the two mating faces should point toward each other. Set Surface offset to 0.5 mm to leave a small separation along the target’s outward normal. Use zero for direct seating.',
        'Turn opposing normals off only when the two chosen normals should point in the same direction, such as registering corresponding outward faces. A single face normal does not describe a unique twist around that normal. If a keyed interface still faces the wrong way, use additional landmarks with 3+ point fit.',
      ],
      caption:
        'Opposing face normals and a 0.5 mm offset specify the mating direction and separation.',
    },
    {
      title: 'Apply and verify face orientation',
      paragraphs: [
        'Click Apply alignment. The orange block turns so the chosen faces oppose each other and the picked centers seat with the requested clearance, unless other relationships or No clip limit the placement.',
        'Inspect the seam from the front, side, and above. If the block flips unexpectedly, undo and review which face was picked and the Opposing face normals switch. Save the result when satisfied. Use a kept Mate planes constraint if the planes must remain related during future edits.',
      ],
      caption: 'The orange face has rotated into alignment with the teal mating face.',
    },
  ],
  ['tutorial-mate', 'tutorial-multi-point', 'alignment', 'planes'],
);

const multiPoint = tutorial(
  'multi-point',
  '3+ point fit: match several landmarks',
  'Build a rigid fit from three or more corresponding point pairs and read the remaining error.',
  'Use 3+ point fit when a single point or normal leaves the interface orientation ambiguous. Each pair describes the same physical landmark on two parts. The solver balances all pairs with translation and rotation, preserving scale and mesh shape.',
  'align',
  [
    {
      title: 'Choose the fit and plan three landmarks',
      paragraphs: [
        'Select Moving block, press A, and choose 3+ point fit. Assign Target block as the target. Find three recognizable locations spread over the two mating faces; in the example these form a triangle on the right face of the orange block and the left face of the teal block.',
        'Do not choose all points along one edge. A broad triangle defines orientation more reliably than three nearly collinear picks. For a scanned miniature, compare interface corners, socket details, or other features that genuinely correspond.',
      ],
      caption: '3+ point fit is selected and awaits the first of at least three matching pairs.',
    },
    {
      title: 'Pick the first source point',
      paragraphs: [
        'Click one landmark on the orange face. The first marker appears and the prompt requests its target. You must alternate source then target for each pair, rather than picking all source points first.',
        'Ghost other part can expose the surface needed for the next click; the translucent part is click-through. Active part only hides the other part completely. These views follow the next source or target pick automatically.',
      ],
      caption: 'S1 is a pending source pick; its target must be supplied next.',
    },
    {
      title: 'Complete the first correspondence',
      paragraphs: [
        'Orbit to see the same landmark on the teal face and click it. Matching pairs now shows pair 1. One complete pair is not enough; the fit still needs two more.',
        'The screenshot uses the face center to demonstrate the first pair. For the spread-out set in the next step, click Reset, then choose three locations around the interface. Remove pair N deletes only that correspondence; Clear pending source cancels an unfinished extra source when that control appears.',
      ],
      caption: 'One pair is complete; the inspector reports that two more are required.',
    },
    {
      title: 'Spread the pairs and inspect RMS',
      paragraphs: [
        'Create three source–target pairs at lower-back, upper-back, and front-center locations on the opposing block faces. Approximate local positions on the source are X = 10 with (Y, Z) of (−6, −4), (6, −4), and (0, 4); the target uses the same Y and Z with X = −10. These are visual landmarks to click, not coordinate fields in Align.',
        'The inspector now reports three matching pairs and Best-fit RMS error. Add fourth or later pairs when they provide useful independent information; every pair contributes and there is no three-pair cap. Finish or clear any pending source before applying. High RMS can mean mistaken correspondences, incompatible geometry, or movement restrictions.',
      ],
      caption: 'Three spread-out pairs enable the fit and show the achieved RMS in millimeters.',
      tip: 'A small RMS validates these picked correspondences only. It does not prove every unpicked surface is aligned or free of overlap.',
    },
    {
      title: 'Apply the rigid fit and check the seam',
      paragraphs: [
        'Click Apply alignment. The moving block translates and rotates to balance all three pairs while the target stays fixed. Inspect the entire seam from several directions. On real scans, compare the pose with your assembly reference as well as the point error.',
        'If the result is wrong, undo, reset the picks, and replace ambiguous landmarks with clearer ones. Check joints, pins, retained plane constraints, and No clip before increasing the pair count. Save the achieved placement; the temporary fitting pairs are cleared when the fit is applied.',
      ],
      caption:
        'The fitted moving block seats against the target using all three point correspondences.',
    },
  ],
  ['tutorial-contact', 'tutorial-anchors', 'alignment', 'no-clip'],
);

const contact = tutorial(
  'contact',
  'Contact paint: fit matching patches',
  'Paint three or more pairs of contact regions and fit the original surfaces together.',
  'Use contact painting for scanned sockets and uneven mating regions where exact landmark clicks are difficult. Each numbered pair must describe matching areas of the same interface. This exercise paints three separated patches on the opposing side faces of the blocks.',
  'paint',
  [
    {
      title: 'Open Contact best fit and set the brush',
      paragraphs: [
        'Select Moving block and press B for Contact paint, or use Align → Paint contact surfaces. Choose Target block. Under Surface relationship, select Contact best fit · 3+ pairs. Set Brush radius to 3 mm for this practice scene.',
        'On a real scan, roughly position the parts first. This is a local refinement and repeated or symmetric geometry can produce an unwanted match. Use smaller patches that identify the join rather than painting the whole object. Keep No clip enabled and inspect any resulting placement note.',
      ],
      caption: 'Contact best fit · 3+ pairs is selected with a 3 mm brush radius.',
    },
    {
      title: 'Paint the first moving patch',
      paragraphs: [
        'Orbit to the orange block’s right face. Drag a small patch near its lower-back region. The Moving button for pair 1 gains a triangle count and a colored overlay appears on the mesh.',
        'A patch grows through connected triangles; it cannot jump to a detached island. Use [ and ] to change radius, Alt or Erase to remove triangles, and Undo last paint stroke to correct a stroke. Stay on seed plane can limit spill onto a bevel; clear the patch to choose a new seed.',
      ],
      caption: 'Pair 1 has a painted moving patch and is waiting for its target patch.',
    },
    {
      title: 'Paint the matching target patch',
      paragraphs: [
        'Click Next: paint target, orbit to the teal block’s left face, and paint the corresponding lower-back region. Click Finish pair. Both Moving and Target now have triangle counts for pair 1.',
        'Aim for the same physical area on each side. Broadly painting unrelated parts of the two faces gives the solver misleading correspondences. In a crowded scene, Ghost other part keeps the active surface solid while making the other part translucent and unpickable.',
      ],
      caption: 'Both sides of pair 1 are painted and the first contact pair is complete.',
    },
    {
      title: 'Add two independent regions and review the fit',
      paragraphs: [
        'Click Add surface pair. Repeat moving patch → Next: paint target → target patch → Finish pair for the upper-back region, then for a region near the front-center. These three patches form a triangle across the interface. The screenshot uses three complete pairs; extra useful pairs are supported.',
        'Finish or remove every incomplete pair. Leave Opposing face normals on for these inward-facing contacts and Surface offset at zero. Read Contact RMS, which measures sampled distances to the matching painted surfaces after fitting. A poor result is a reason to check correspondence and constraints, not to cover more unrelated surface.',
      ],
      caption: 'Three complete surface pairs enable Fit contact surfaces and show contact RMS.',
    },
    {
      title: 'Fit, inspect, and save',
      paragraphs: [
        'Click Fit contact surfaces. The moving part receives one rigid translation and rotation; it is not bent, scaled, or welded. The temporary paint clears after applying. Orbit around all three contact regions and check unpainted neighbors for interference.',
        'Undo if the interface lands on the wrong repeated feature, rough-position it more accurately, and repaint. Save scene to keep the placement. Use anchors for deliberate small target adjustments afterward, or painted plane constraints for flat relationships that must survive later transforms.',
      ],
      caption:
        'The contact fit has been applied; the blocks are seated and temporary paint is cleared.',
    },
  ],
  ['contact-paint', 'tutorial-flush', 'tutorial-mate', 'tutorial-anchors'],
);

const flush = tutorial(
  'flush',
  'Flush paint: continue a surface across seams',
  'Balance height and tilt at one or more seams while preserving sideways spacing.',
  'Use Paint flush when outward surfaces should continue smoothly across a gap, such as adjacent armor panels. The exercise starts with the orange block slightly proud and tilted relative to its neighbor. Both front faces should face outward in the same direction.',
  'layers',
  [
    {
      title: 'Choose flush fitting near the intended pose',
      paragraphs: [
        'Select Moving block and press B. Choose Paint flush · across seams under Surface relationship. Set Brush radius to 3 mm and keep Alignment view on Full scene for the across-gap stroke shown here.',
        'Flush fitting makes a small local correction, limited to 30° from the starting orientation. Roughly place a distant or backward part first. The operation adjusts surface height and tilt; it is not intended to pull the centers of the two patches onto each other.',
      ],
      caption: 'Paint flush · across seams is selected for the slightly tilted neighboring blocks.',
    },
    {
      title: 'Start on the moving side of the seam',
      paragraphs: [
        'Paint a small area on the orange front face beside the lower half of the gap. The example starts near the right edge, away from the side-wall bevel. Keep each patch locally flat so it describes the surface you want to continue.',
        'The moving patch appears in pair 1. In Full scene or Isolate both parts, continue the same drag across empty space onto the neighbor, or paint the neighbor with a second stroke. The tool assigns both sides automatically.',
      ],
      caption:
        'The first seam contains a moving patch beside the gap and still needs its neighboring patch.',
    },
    {
      title: 'Finish the neighbor side and check the preview',
      paragraphs: [
        'Paint the matching outer face on the teal block beside the same seam. A complete pair produces a cyan preview and height/tilt residuals. One complete seam is sufficient to apply a flush fit.',
        'In Active part only or Ghost other part, the workflow is different: paint the moving patch, click Next: paint target, paint the visible target, and click Finish pair. You cannot paint the hidden or ghosted part through the active side. Return to Full scene before adding seams to different neighbors.',
      ],
      caption: 'The first seam is complete and a cyan ghost previews the flush correction.',
    },
    {
      title: 'Include every seam that must remain aligned',
      paragraphs: [
        'Click Add seam and paint another pair near the upper half of the gap. On a surrounded panel, use additional seams against each important neighbor; different seams may target different stationary parts. They all participate in the same rigid solve.',
        'Inspect each seam’s height and tilt plus overall height RMS and maximum tilt. Errors above 0.05 mm or 1° are flagged as a compromise. Curved patches, incompatible seams, pins, joints, locks, retained constraints, and the local rotation limit can prevent a perfect result. An unpainted connection without another constraint is not automatically protected.',
      ],
      caption:
        'Two completed seams share a single preview, with per-seam height and tilt readouts.',
    },
    {
      title: 'Apply and inspect surface continuity',
      paragraphs: [
        'Click Apply flush fit. The orange block changes height and tilt while the neighbor stays fixed. Inspect from an oblique angle across the seam so a remaining lip is visible; a straight-on view can hide a depth mismatch.',
        'The gap remains intentional: this tool does not weld edges or fill holes. Undo restores the old placement. Applying clears the temporary painted regions; save the scene for the new transforms, and use joints or retained plane constraints for relationships that must govern future edits.',
      ],
      caption: 'The front surfaces continue across the gap after the flush correction.',
    },
  ],
  ['flush-fit', 'tutorial-contact', 'tutorial-mate', 'no-clip'],
);

type PlaneLesson = {
  slug: 'mate' | 'parallel' | 'perpendicular' | 'angle';
  title: string;
  description: string;
  intro: string;
  movingFace: string;
  targetFace: string;
  settings: string[];
  settingCaption: string;
  result: string;
  freedom: string;
};
function planeTutorial(lesson: PlaneLesson) {
  const label = {
    mate: 'Mate planes',
    parallel: 'Parallel',
    perpendicular: 'Perpendicular',
    angle: 'Angle',
  }[lesson.slug];
  return tutorial(
    lesson.slug,
    lesson.title,
    lesson.description,
    lesson.intro,
    'layers',
    [
      {
        title: `Choose ${label} in Contact paint`,
        paragraphs: [
          `Select Moving block and press B. Set Target part to Target block. In Surface relationship choose ${label} · 1+ pairs. Set Brush radius to 3 mm. Reset Explode and confirm that the moving block is visible and unlocked.`,
          'These methods fit a plane over each painted region. One complete pair is enough, unlike Contact best fit, which needs three pairs. Choose broad enough, locally flat patches to define stable normals; a narrow line or a strongly curved patch may not define a usable plane.',
        ],
        caption: `${label} · 1+ pairs is selected in the Surface relationship menu.`,
      },
      {
        title: 'Paint the moving plane',
        paragraphs: [
          `Orbit to see ${lesson.movingFace} and paint a small area on it. The Moving button for pair 1 shows a triangle count. Keep the brush away from edges that turn onto another face.`,
          'Enable Stay on seed plane when the brush needs help staying on a flat region. Normal tolerance limits the change in face direction and Plane tolerance limits distance from the first hit’s plane. Alt erases, Undo last paint stroke reverses a stroke, and Clear this patch lets you begin with a new seed.',
        ],
        caption: `A moving patch on ${lesson.movingFace} defines the first plane.`,
      },
      {
        title: 'Paint the stationary reference plane',
        paragraphs: [
          `Click Next: paint target. Orbit to ${lesson.targetFace}, paint its locally flat area, and click Finish pair. Both sides of pair 1 should have triangle counts, and the status should say Ready for plane alignment.`,
          'The target drives the moving part. Ghost other part or Active part only helps expose hidden faces while following the painting stage. If Add surface pair is disabled, finish or remove the incomplete pair. Add further pairs only to express compatible additional plane relationships.',
        ],
        caption: `One complete pair supplies the moving and target planes for ${label}.`,
      },
      {
        title: 'Set the relationship and keep it active',
        paragraphs: [
          ...lesson.settings,
          'Turn Keep constraint active on. The apply button changes to Create plane constraints. This stores the relationship so it continues to govern later edits. Leave the switch off for a one-time placement; the button then applies the named relationship without retaining it. Review the angle residual, and the seating residual for Mate planes, before continuing.',
        ],
        caption: lesson.settingCaption,
      },
      {
        title: 'Create and inspect the relationship',
        paragraphs: [
          `Click Create plane constraints, then open the Constraints tab in the left panel. ${lesson.result} The card names the target and moving part, exposes the relationship settings, and reports the remaining error. Rename it to describe the interface on a real assembly.`,
          lesson.freedom,
          'Check the whole assembly for interference. A kept plane relationship remains authoritative, so No clip cannot always eliminate overlap that the relationship requires. If incompatible or circular constraints produce an error, the previous scene is retained; revise the conflicting relationship rather than adding more constraints.',
        ],
        caption: `The Constraints tab shows the active ${label} relationship and its residual after creation.`,
      },
      {
        title: 'Suppress, revise, and save the constraint',
        paragraphs: [
          'Click the constraint’s Active switch. It now reads Suppressed and its residual says Not enforced, as shown. The definition remains in the scene while this relationship stops governing movement. Other active constraints, joints, pins, and fixed locks still apply.',
          'Turn it back on when the relationship should apply again. Edit Relationship and the applicable Face direction, Offset, or Normal angle fields to revise it. Removing the card deletes the relationship entirely. Save scene to preserve both its definition and enabled state. Undo reverses an unwanted edit.',
        ],
        caption: `The ${label} constraint is suppressed and reports Not enforced without being deleted.`,
      },
    ],
    ['planes', 'tutorial-plane-to-plane', 'tutorial-flush', 'tutorial-joints'],
  );
}

const planes = [
  planeTutorial({
    slug: 'mate',
    title: 'Mate planes: keep two faces seated',
    description:
      'Paint two planar regions, set a signed separation, and retain their mating relationship.',
    intro:
      'Use Mate planes to keep flat interfaces seated through later edits. Unlike a picked Plane to plane fit, a mate constrains the planes without forcing the two patch centers to coincide. Here the orange right face mates to the teal left face with 0.5 mm clearance.',
    movingFace: 'the orange block’s right face beside the gap',
    targetFace: 'the teal block’s left face beside the gap',
    settings: [
      'Leave Opposing face normals on so the mating faces face each other. Enter 0.5 mm in Surface offset. The signed offset is measured along the target normal: positive moves the source plane outward, negative requests the opposite side. Use zero for coincident planes.',
      'Do not use offset to hide incorrect face selection or scale. On a rough scan, repaint a representative flat region if the fitted plane tilts away from the intended interface.',
    ],
    settingCaption:
      'Mate planes uses opposing normals, 0.5 mm Surface offset, and Keep constraint active.',
    result: 'The moving face turns and seats at the specified distance from the target plane.',
    freedom:
      'A single mate still allows sliding within the plane and rotation around its normal. That is expected. Use a compatible second relationship or a joint if the assembly needs less freedom; a mate alone does not lock the complete pose.',
  }),
  planeTutorial({
    slug: 'parallel',
    title: 'Parallel: match plane directions',
    description:
      'Keep two painted planes parallel while allowing their spacing and sideways position to change.',
    intro:
      'Use Parallel when two surfaces should share a direction but should not be seated onto one another. This exercise aligns the front faces of the blocks so their outward normals point the same way while preserving their freedom to move apart.',
    movingFace: 'the orange block’s broad front face',
    targetFace: 'the teal block’s broad front face',
    settings: [
      'Turn Opposing face normals off for these two outward front faces. Their normals should point in the same direction. Leave it on when the planes should be parallel with normals facing opposite ways, such as opposite walls of an enclosure.',
      'Parallel has no Surface offset field because it does not set the distance between planes. Use Mate planes when a particular separation should be enforced. The plane angle error should approach zero for this unconstrained practice assembly.',
    ],
    settingCaption: 'Parallel uses the same normal direction, with Keep constraint active enabled.',
    result: 'The orange front plane becomes parallel to the teal front plane.',
    freedom:
      'Translation remains free, as does rotation that preserves the parallel normals. A gap or sideways offset is not an error in this relationship. To position the part precisely, add a compatible placement relationship or move it within the allowed freedom.',
  }),
  planeTutorial({
    slug: 'perpendicular',
    title: 'Perpendicular: make a right angle',
    description:
      'Rotate two painted plane normals to 90° and preserve that relationship during later edits.',
    intro:
      'Use Perpendicular for a bracket, upright, or panel that must stand at a right angle to a reference surface. This exercise turns the orange front face to a right angle relative to the teal front face. It controls orientation, not where the planes meet.',
    movingFace: 'the orange block’s broad front face',
    targetFace: 'the teal block’s broad front face',
    settings: [
      'Perpendicular fixes the angle between the fitted normals at 90°. There is no editable angle or offset for this method, and flipping a normal still describes perpendicular planes. Review the angle residual to judge the achieved relationship.',
      'The solver chooses an orientation consistent with the available freedom and existing relationships. The equation does not identify a unique hinge line or intersection point. Use a joint for a specific hinge, or another compatible constraint when its location must also be controlled.',
    ],
    settingCaption: 'Perpendicular is ready to create an active 90° plane relationship.',
    result: 'The orange face is turned to 90° relative to the teal face.',
    freedom:
      'The part can still translate and rotate in ways that keep the normals perpendicular. A correct right angle does not automatically put an edge on the target. Check placement separately and preserve it with another compatible relationship when needed.',
  }),
  planeTutorial({
    slug: 'angle',
    title: 'Angle: set a precise plane angle',
    description:
      'Set the angle between painted plane normals, then edit or suppress the retained relationship.',
    intro:
      'Use Angle for a panel or bracket that must maintain a specified orientation relative to another part. Here the two front-face normals are set 45° apart. The input describes normals, which may differ from the interior angle you see between solid faces.',
    movingFace: 'the orange block’s broad front face',
    targetFace: 'the teal block’s broad front face',
    settings: [
      'Set Normal angle to 45°. The accepted range is 0–180°. Zero means the two normals point the same way, 90° means perpendicular, and 180° means opposite. There is no Surface offset because this relationship does not control separation.',
      'Check the direction of the actual picked surfaces. Depending on which side of each part you paint, a desired interior angle may need its supplementary normal angle. Inspect the geometry rather than assuming the visible wedge and normal angle are identical.',
    ],
    settingCaption:
      'Normal angle is 45°, and Keep constraint active will preserve it during later edits.',
    result: 'The moving plane turns until its normal is 45° from the target normal.',
    freedom:
      'Translation and rotations that preserve that angle remain free. The constraint alone does not fix a hinge axis, an edge contact, or sideways placement. Add compatible relationships only for the additional freedom you actually need to remove.',
  }),
];

const anchors = tutorial(
  'anchors',
  'Anchors: refine a rigid fit',
  'Move persistent surface targets while balancing the other anchors and reading their residual gaps.',
  'Use Anchors for controlled fine adjustments after rough placement. An attachment stays on the mesh while its world-space target can move. The part follows a rigid best fit to all targets; the mesh never stretches to satisfy incompatible demands.',
  'pin',
  [
    {
      title: 'Select the part and enter anchor editing',
      paragraphs: [
        'Select Moving block and press K, or choose Anchors in the toolbar. In Rigid anchor fit, confirm Anchor moving part is Moving block. Reset Explode to zero. Hidden or locked parts cannot be edited.',
        'Choose Add anchors on surface if adding is not already active. Unlike Align, there is no separate target-part selector: each target is a position in world space. The neighboring teal block is only a visual reference in this exercise.',
      ],
      caption: 'Rigid anchor fit is open for Moving block, ready to add surface attachments.',
    },
    {
      title: 'Place anchors around the interface',
      paragraphs: [
        'Click three spread-out positions on the orange front face: lower-left, lower-right, and upper-center. Click Finish adding anchors. Each target initially coincides with its surface attachment, so the gaps start at zero.',
        'Three noncollinear anchors give a useful orientation reference. One or two anchors also work but leave more rotational freedom. Avoid placing several nearly identical points just to increase the count; the targets are balanced equally, not assigned individual priorities.',
      ],
      caption: 'Three anchors span the moving face and initially have zero target gaps.',
    },
    {
      title: 'Select the target you want to change',
      paragraphs: [
        'Click Anchor 1 in the list or its numbered target marker. Its XYZ handle appears. The inspector shows Anchor 1 target · world mm with X, Y, and Z coordinates.',
        'The larger target circle and the attachment dot are different positions. You are editing the target, not moving a vertex of the mesh. The other targets stay where they were and continue to influence the rigid solve.',
      ],
      caption: 'Anchor 1 is selected, exposing its world target coordinates and transform handle.',
    },
    {
      title: 'Move one target and judge the compromise',
      paragraphs: [
        'Add 3 mm to Anchor target X and press Enter. Alternatively drag the target’s X handle; hold Shift for one-tenth sensitivity. Numeric target controls allow 0.01 mm steps. The part moves and rotates immediately, with no separate Apply button.',
        'Read the per-anchor gaps and Fit gap RMS. Moving only one of three targets generally changes their mutual distances, so one rigid part cannot hit all three exactly. Lines show the remaining residuals. Check joints, plane constraints, pins, and No clip if the achieved movement is unexpectedly limited.',
      ],
      caption:
        'Moving Anchor 1’s X target leaves visible residual gaps while the block stays rigid.',
    },
    {
      title: 'Accept the pose as the next baseline',
      paragraphs: [
        'When satisfied, click Hold current positions. Every target is reset to its achieved surface attachment, so the residuals return to zero without moving the part. Use this before starting a new independent refinement.',
        'Press Esc to leave anchor editing and Save scene to preserve anchors and targets. Remove an anchor with its list remove button; undo reverses target changes. Ordinary transforms do not move the world targets with the part, so return to Anchors and rebase when that new pose should become the baseline.',
      ],
      caption:
        'Hold current positions rebases the targets to the achieved pose, clearing the old gaps.',
    },
  ],
  ['anchors', 'tutorial-hard-pins', 'tutorial-soft-pins', 'tutorial-multi-point'],
);

const hardPins = tutorial(
  'hard-pins',
  'Hard pins: hold a point while posing',
  'Place fixed world-space pins and rotate the part around the remaining freedom.',
  'Use hard pins when a surface point must stay exactly in place while you pose a part. Unlike an anchor target, a hard pin is a movement restriction that stays active across positioning tools. This exercise keeps one orange-block point fixed while rotating the block.',
  'pin',
  [
    {
      title: 'Select a part and choose Pin',
      paragraphs: [
        'Select Moving block and choose Pin in the toolbar. Confirm Part to pin is Moving block. If hard-pin placement is not already active, choose Pin in the Pins panel. The prompt should ask you to click the selected part’s surface; clicking an already active Pin button stops placement.',
        'The part must be visible and unlocked, with Explode at zero. Begin with one pin so you can see what freedom remains before adding more restrictions.',
      ],
      caption: 'The Pins panel is in hard-pin placement mode for Moving block.',
    },
    {
      title: 'Place a fixed point',
      paragraphs: [
        'Click near the lower-left corner of the orange front face, then click Finish placing pins. An orange P marker appears and the list describes Pin 1 as Fixed.',
        'The attachment is stored on the mesh and its fixed target stays in world space. It is not a connection to the teal block, and moving the teal block will not carry this point. Use a joint when one part must follow another.',
      ],
      caption: 'A single hard pin fixes the lower-left surface point in world space.',
    },
    {
      title: 'Switch to rotation',
      paragraphs: [
        'Choose Rotate part in the Pins panel, or press R. Drag a rotation ring to pose the orange block. The pin stays active after leaving the Pin tool, and the part translates as necessary to keep that surface point fixed.',
        'Hold Shift for fine control. A blocked move is often expected: one hard pin leaves rotation about its point, two distinct pins leave rotation about their shared axis, and three noncollinear pins hold the whole pose. Existing joint and plane constraints can remove more freedom.',
      ],
      caption: 'Rotate is active while Pin 1 remains attached and fixed.',
    },
    {
      title: 'Check the pin after posing',
      paragraphs: [
        'Return to Pin after a small rotation. The orange block’s orientation has changed, but P1 is still at the same world-space location. Check the join from more than one view rather than judging only its silhouette.',
        'If movement is blocked, remove an unnecessary pin or change Pin type to Soft pin · elastic when some give is intended. Converting a soft pin to a hard pin fixes its current surface point, not its earlier resting target. No clip and other relationships still affect the achieved placement.',
      ],
      caption: 'The block has rotated around the fixed P1 point without changing its shape.',
    },
    {
      title: 'Manage the fixed point and save',
      paragraphs: [
        'Reset resting points records the current attachments for all pins on this part. For this correctly satisfied hard pin, the fixed position already matches its attachment, so the pose does not change. This control is more visibly useful for stretched soft pins.',
        'Remove pin 1 releases the restriction entirely. Leave it present if the point must stay fixed in later work. Save scene preserves pins; pin creation, deletion, and changes are undoable. To move the whole object freely, remove or soften the pin rather than repeatedly dragging against it.',
      ],
      caption: 'The hard pin remains Fixed after resetting resting points at the current pose.',
    },
  ],
  ['pins', 'tutorial-soft-pins', 'tutorial-anchors', 'tutorial-joints'],
);

const softPins = tutorial(
  'soft-pins',
  'Soft pins: balance movement priorities',
  'Give different attachment points adjustable resistance and compare how far they stretch.',
  'Use soft pins when one area should resist movement strongly while another may give. The part remains rigid, and it stays where you release it. This exercise places two pins with priorities 85 and 15 so their differing resistance is easy to compare.',
  'pin',
  [
    {
      title: 'Enter soft-pin placement',
      paragraphs: [
        'Select Moving block and choose Pin in the toolbar, then Soft pin in the Pins panel. Check the selected part, reset Explode, and keep the part visible and unlocked.',
        'Plan one strongly held location near the lower-left of the orange front face and a weaker one near the upper-right. The teal block is a visual reference; soft pins store resting points in world space rather than attaching themselves to another part.',
      ],
      caption: 'Soft pin placement is active for the orange moving block.',
    },
    {
      title: 'Place two resting points',
      paragraphs: [
        'Click the lower-left and upper-right locations on the orange face, then Finish placing pins. Two teal S markers appear and both initially have zero stretch because their resting targets coincide with their surface attachments.',
        'Select a pin by its marker or its row in the list. The selected pin’s settings apply only to that pin; the list lets you compare priorities and stretch across the others.',
      ],
      caption: 'Two soft pins mark opposite regions of the face before any movement.',
    },
    {
      title: 'Give the pins different priorities',
      paragraphs: [
        'Select Soft pin 1 and set Priority to 85 using the numeric field or slider. Select Soft pin 2 and set Priority to 15. The list now shows both values, with pin 2 selected in the example.',
        'Priority ranges from 0, which is free, to 100, the strongest soft resistance. Resistance increases exponentially, so a higher number is not a linear percentage of movement prevented. Priority 100 is still soft; choose Hard pin · fixed point for an exact restriction.',
      ],
      caption: 'Soft pin 1 has priority 85 and Soft pin 2 has priority 15.',
    },
    {
      title: 'Pose the part and compare stretch',
      paragraphs: [
        'Choose Rotate part or press R and make a modest rotation, then return to Pin. The stronger point generally moves less while the weaker one stretches farther. Read the millimeter stretch beside each pin and the selected pin’s more precise Stretch readout.',
        'Lines join resting targets to current surface attachments. They show where the rigid placement compromises; they do not indicate a stretched mesh. The part remains where you release it and does not spring back automatically. Exact gaps depend on the gesture, other constraints, and No clip.',
      ],
      caption: 'After rotation, the lower-priority pin stretches farther than the stronger pin.',
    },
    {
      title: 'Reset the resting points for another adjustment',
      paragraphs: [
        'Click Reset resting points when the achieved pose should become the new baseline. Both resting targets move to their current surface attachments, the stretch drops to zero, and the part stays in place. The priorities remain 85 and 15.',
        'Without a reset, later movement still resists displacement from the earlier resting targets. Remove unwanted pins or change their type and priority as the fitting task changes. Save scene to retain the chosen pins, priorities, and resting positions; use undo if you reset too soon.',
      ],
      caption:
        'Reset resting points clears both stretch values while preserving their different priorities.',
    },
  ],
  ['pins', 'tutorial-hard-pins', 'tutorial-anchors', 'tutorial-precision'],
);

const joints = tutorial(
  'joints',
  'Joints: align and keep parts connected',
  'Pick a child and parent anchor, define rotational freedom, and pose a persistent connection.',
  'Use a joint when a part should remain attached to another part during posing. This exercise connects the orange block as a child of the teal block, then leaves one rotation axis free to make a hinge-like connection.',
  'link',
  [
    {
      title: 'Choose the moving child and target parent',
      paragraphs: [
        'Select Moving block and press J, or choose Joint in the toolbar. Confirm Moving block as Moving part and Target block as Target part. The target is the parent that drives the connection.',
        'A part can have one parent, and circular parent–child chains are prevented. Plan the hierarchy before connecting a real miniature: for example torso → upper arm → hand. A world reference plane cannot serve as a joint parent.',
      ],
      caption: 'Joint anchors assigns Moving block as child and Target block as parent.',
    },
    {
      title: 'Pick the child’s attachment point',
      paragraphs: [
        'Click near the center of the orange block’s right face. The source marker identifies the child attachment point and the prompt requests the matching target.',
        'Choose the intended pivot location, such as a ball center or hinge point. A joint preserves this connection during later rotation; an arbitrary surface pick can produce an unexpected orbit even when the two points seat correctly.',
      ],
      caption: 'The child attachment has been picked and is waiting for its parent anchor.',
    },
    {
      title: 'Pick the parent’s attachment point',
      paragraphs: [
        'Orbit to the teal block’s left face and click its center. The completed pair defines the two points that will be seated when you create the joint. Use Reset if the anchors describe different physical locations.',
        'A joint does not automatically fit the surrounding surfaces or infer the keyed orientation. Roughly pose the part or use another alignment method first if the geometry needs more than matching anchor positions.',
      ],
      caption: 'The source and target joint anchors form a completed pair.',
    },
    {
      title: 'Choose a hinge or a fixed connection',
      paragraphs: [
        'Leave Keep connected on. Under Lock rotation per axis, lock X and Y and leave Z free, as in the screenshot. This allows rotation on the joint’s Z axis while keeping the anchor points together.',
        'Lock all three axes for a fixed joint, or leave more axes free for a poseable connection. Turning Keep connected off seats the anchors once but leaves the connection inactive afterward. Axis locks use joint axes, which may differ from world axes.',
      ],
      caption: 'Keep connected is on, X and Y are locked, and Z is free for the hinge.',
    },
    {
      title: 'Create, pose, and save the joint',
      paragraphs: [
        'Click Create joint. Choose Rotate and set Rotation Z to 25° in the inspector, or drag the free rotation ring. The orange block rotates about the joint anchor and stays attached to the teal parent. Connected descendants follow their parent.',
        'Use the Joints tab or the selected part’s joint controls to change Keep connected or rotation locks. Locking a free axis captures its current pose. Joint creation seats the anchors directly, so inspect surrounding surfaces for overlap; a connected point alone does not guarantee a printable join. Save scene to retain the connection and pose.',
      ],
      caption: 'The connected child is posed 25° around the joint’s free Z axis.',
    },
  ],
  ['joints', 'tutorial-hard-pins', 'tutorial-mate', 'tutorial-precision'],
);

const precision = tutorial(
  'precision',
  'Transforms: place and fine-tune manually',
  'Use combined handles, exact values, incremental moves, custom pivots, and free pointer placement.',
  'Use manual transforms for rough placement before fitting and deliberate finishing afterward. This walkthrough covers the positioning controls that complement every alignment method. Scale changes dimensions, so keep it unchanged when assembling parts that already have the correct size.',
  'move',
  [
    {
      title: 'Select the part and choose handles',
      paragraphs: [
        'Select Moving block and press T for Transform. Arrows move along axes, squares move within planes, and rings rotate. Axis cubes scale along one axis and the center cube scales uniformly. Turn Enable scaling off if you want to avoid accidental dimension changes.',
        'G, R, and S choose separate Move, Rotate, and Scale tools. Shift-click adds parts to a selection. World axes stay aligned with the scene; Local axes follow one part’s orientation. Multiple selections use world axes, while connected parts use joint axes. Read the inspector’s axes and pivot labels before dragging.',
      ],
      caption:
        'The combined Transform tool shows movement, rotation, and optional scaling handles.',
    },
    {
      title: 'Enter an exact position',
      paragraphs: [
        'Press G for Move. In Position, set X to −12 mm and press Enter. This is an absolute world coordinate for the part’s origin, not a distance to move and not the X coordinate of a particular surface landmark.',
        'The orange block moves toward the target while its rotation and scale remain unchanged. Rotation fields use the axes stated in their label; Scale fields are factors. No clip, pins, joints, and active plane constraints can limit the achieved pose, so read any placement note rather than repeatedly entering a blocked value.',
      ],
      caption: 'Position X is set to −12 mm for exact world-space placement.',
    },
    {
      title: 'Use small steps and fine dragging',
      paragraphs: [
        'Set Move Step to 0.1 mm, then click X + once. Each axis −/+ button moves by the chosen increment. Turn on Snap dragging to use the same increment with handles. Rotate has its own Step in degrees; the combined Transform tool has separate Move snap and Rotation snap settings.',
        'Hold Shift during a handle drag for one-tenth sensitivity. You can press or release Shift mid-drag without a jump. One continuous drag is one undo step; each step-button adjustment is a separate undo step. Snap increments and precision sensitivity serve different purposes and can be used together.',
      ],
      caption:
        'Move uses a 0.1 mm step with Snap dragging enabled after one positive X adjustment.',
    },
    {
      title: 'Pick a useful rotation pivot',
      paragraphs: [
        'Choose Pick pivot on model in the inspector, or press P, and click the orange block’s right face near the join. Press R. The rotation handle is now centered on the custom pivot instead of the mesh center.',
        'Rotate a small amount to check the intended arc. Reset custom pivot returns to the mesh center. A pivot changes the center of rotation, scaling, and orbiting, but it does not hold that point against later translation. Use a hard pin or joint if that restriction is required. An active joint retains its own anchor as the rotation pivot.',
      ],
      caption:
        'A custom pivot on the right face relocates the rotation handle to the intended join.',
    },
    {
      title: 'Try free pointer placement and finish',
      paragraphs: [
        'With the pointer over the viewport, press Shift + G for free movement or Shift + R for free rotation, then release the shortcut and move the pointer. X, Y, or Z constrains an axis; pressing the same axis again returns to free movement. Hold Shift after releasing the shortcut for fine control.',
        'Enter or left-click confirms the preview. Esc or right-click cancels and restores the starting pose. The screenshot shows a free move waiting for a decision; cancel this practice move if you want to keep the previous placement. Check the final join from several directions and save. Use a fitting method when visual positioning alone cannot establish accurate contact.',
      ],
      caption:
        'Free move displays axis controls and Confirm / Cancel before committing the placement.',
    },
  ],
  ['transforms', 'tutorial-point-to-point', 'tutorial-plane-to-plane', 'tutorial-anchors'],
);

export const alignmentTutorials: DocArticle[] = [
  precision,
  pointToPoint,
  pointToPlane,
  planeToPlane,
  multiPoint,
  contact,
  flush,
  ...planes,
  anchors,
  hardPins,
  softPins,
  joints,
];

export const alignmentTutorialDirectory: DocArticle = {
  id: 'alignment-tutorials',
  title: 'Alignment tutorials',
  description: 'Fifteen animated walkthroughs, with a practice scene and an image at every step.',
  group: 'Build & assemble',
  icon: 'align',
  intro:
    'Choose the relationship your assembly needs, then follow its illustrated tutorial. Each walkthrough includes a playable animation with step captions, an original downloadable two-block scene, and real workbench screenshots. Pause, replay, or slow the animation to inspect how the part moves. The same source/target choices, picks, painted regions, and constraints apply to your miniature parts.',
  image: {
    src: './images/tutorials/multi-point-4.webp',
    alt: 'A practice assembly with three matching landmark pairs and the rigid-fit RMS visible in the inspector.',
    caption:
      'Each tutorial follows an operation from initial setup to the achieved placement, with an image for every numbered step.',
  },
  sections: [
    {
      id: 'choose-a-tutorial',
      title: 'Choose by the result you need',
      table: {
        headers: ['Method or tool', 'Use it when', 'Minimum input'],
        rows: [
          [
            'Manual transforms',
            'Place a part by eye or exact coordinates; refine with steps or a pivot.',
            'A selected part',
          ],
          ['Point to point', 'Match a landmark without changing orientation.', 'One point pair'],
          [
            'Point to plane',
            'Set a point’s distance from a plane without leveling the part.',
            'One source point and target plane pick',
          ],
          [
            'Plane to plane',
            'Orient two picked face normals and seat their points once.',
            'One point/normal pair',
          ],
          [
            '3+ point fit',
            'Resolve position and orientation using matching landmarks.',
            'Three noncollinear point pairs',
          ],
          [
            'Contact paint',
            'Fit corresponding regions of irregular mating surfaces.',
            'Three complete patch pairs',
          ],
          [
            'Flush paint',
            'Continue outer faces across seams while preserving sideways spacing.',
            'One complete seam; more for multiple connections',
          ],
          [
            'Mate planes',
            'Keep flat faces seated at a signed separation.',
            'One complete planar patch pair',
          ],
          [
            'Parallel',
            'Match plane directions while leaving spacing free.',
            'One complete planar patch pair',
          ],
          ['Perpendicular', 'Keep plane normals 90° apart.', 'One complete planar patch pair'],
          [
            'Angle',
            'Keep a specified angle between plane normals.',
            'One complete planar patch pair and an angle',
          ],
          [
            'Anchors',
            'Fine-tune persistent world targets with a rigid best fit.',
            'One anchor; three spread-out points for orientation',
          ],
          ['Hard pins', 'Hold a point exactly in world space while posing.', 'One surface pin'],
          [
            'Soft pins',
            'Give different points different resistance to movement.',
            'One or more pins with priorities',
          ],
          [
            'Joints',
            'Keep a child attached to a parent with chosen rotation freedom.',
            'A child and parent anchor pair',
          ],
        ],
      },
    },
    {
      id: 'practice-setup',
      title: 'Prepare a practice session',
      paragraphs: [
        'Save your assembly before opening a downloaded practice scene with File → Open scene. Every tutorial starts with an orange Moving block and a teal Target block. The downloadable scene supplies the geometry and starting transforms; follow step 1 to choose the tool and settings. Imported scenes do not replace your browser preferences.',
        'Reset Explode to zero, keep the moving part unlocked, and make the relevant parts visible. The screenshots use an orthographic view, Editor colors, and No clip enabled with 0.1 mm allowed overlap. Use the view cube to inspect another direction; camera framing need not exactly match the screenshot.',
        'Click any step image to enlarge it in place. Close it with the close button, Escape, or the backdrop. The sidebar, search, and the links below open each complete walkthrough.',
      ],
    },
    {
      id: 'shared-checks',
      title: 'Read the achieved result',
      paragraphs: [
        'For a one-time fit, check the residual or collision note before applying, then inspect the join from several angles. For anchors, pins, and direct transforms, changes apply as you edit. Undo lets you compare with the previous placement.',
        'Joints, pins, fixed locks, retained plane constraints, and No clip can restrict movement. A point match, low RMS, or satisfied plane equation describes only that relationship. Inspect unpicked surfaces and interference separately. Save scene preserves the achieved placement and persistent relationships; temporary point pairs and painted patches clear after applying.',
      ],
    },
  ],
  related: alignmentTutorials.map((article) => article.id),
};
