import {
  BufferGeometry,
  Color,
  Group,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Vector3,
} from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import {
  bakedPartGeometry,
  isMirrored,
  partMatrix,
  sceneBounds,
  serializeGeometry,
  transformFromMatrix,
  triangleCount,
  uid,
} from './geometry';
import { sceneSubset, serializeScene } from './scene-file';
import type { Part, SceneDocument } from './types';

export const safeFilename = (name: string) =>
  name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').trim() || 'Assembly';
const xml = (s: string) =>
  s.replace(
    /[<>&"']/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!,
  );

export function download(data: BlobPart, filename: string, type = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export function saveSceneFile(scene: SceneDocument) {
  download(
    JSON.stringify(serializeScene(scene)),
    `${safeFilename(scene.name)}.kitbash`,
    'application/json',
  );
}

export interface ImportOptions {
  units: 'auto' | 'mm' | 'cm' | 'm' | 'in';
  up: 'auto' | 'y' | 'z';
  center: boolean;
}

export async function importModels(files: File[], options: ImportOptions): Promise<Part[]> {
  const results: Part[] = [];
  for (const file of files) {
    if (file.size > 250 * 1024 * 1024)
      throw new Error(`${file.name} exceeds the 250 MB per-file limit.`);
    const ext = file.name.split('.').pop()?.toLowerCase(),
      buffer = await file.arrayBuffer();
    if (!['stl', 'obj', 'glb', 'gltf', '3mf'].includes(ext ?? ''))
      throw new Error(`${file.name}: supported formats are STL, OBJ, GLB, embedded GLTF, and 3MF.`);
    let root: Object3D;
    try {
      if (ext === 'stl') {
        root = new Mesh(
          new STLLoader().parse(buffer),
          new MeshStandardMaterial({ color: '#c5c2b8' }),
        );
      } else if (ext === 'obj') root = new OBJLoader().parse(new TextDecoder().decode(buffer));
      else if (ext === '3mf') root = new ThreeMFLoader().parse(buffer);
      else {
        const gltf = await new GLTFLoader().parseAsync(
          ext === 'glb' ? buffer : new TextDecoder().decode(buffer),
          '',
        );
        root = gltf.scene;
      }
    } catch (error) {
      // Loader errors describe parser internals, such as out-of-bounds reads.
      throw new Error(
        `${file.name} could not be read. The file may be damaged. (${(error as Error).message})`,
      );
    }
    const unit =
      options.units === 'auto' ? (ext === 'glb' || ext === 'gltf' ? 'm' : 'mm') : options.units;
    const up = options.up === 'auto' ? (ext === 'glb' || ext === 'gltf' ? 'y' : 'z') : options.up;
    let factor = { mm: 1, cm: 10, m: 1000, in: 25.4 }[unit];
    if (ext === '3mf' && options.units === 'auto') {
      const entries = unzipSync(new Uint8Array(buffer));
      const model = Object.entries(entries).find(([name]) => name.toLowerCase().endsWith('.model'));
      if (model) {
        const declared =
          strFromU8(model[1]).match(/<model\b[^>]*\bunit\s*=\s*["']([^"']+)["']/i)?.[1] ??
          'millimeter';
        factor =
          (
            {
              micron: 0.001,
              millimeter: 1,
              centimeter: 10,
              inch: 25.4,
              foot: 304.8,
              meter: 1000,
            } as Record<string, number>
          )[declared] ?? 1;
      }
    }
    const correction = new Matrix4().makeScale(factor, factor, factor);
    if (up === 'z') correction.multiply(new Matrix4().makeRotationX(-Math.PI / 2));
    root.updateMatrixWorld(true);
    let meshIndex = 0;
    root.traverse((object) => {
      if (!(object instanceof Mesh) || !object.geometry?.getAttribute('position')) return;
      // An empty part could never be reopened: scene files reject meshes without triangles.
      if (triangleCount(object.geometry) < 1) return;
      const geometry: BufferGeometry = object.geometry.clone();
      if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
      const positions = geometry.getAttribute('position');
      for (let i = 0; i < positions.count; i++)
        if (
          !Number.isFinite(positions.getX(i)) ||
          !Number.isFinite(positions.getY(i)) ||
          !Number.isFinite(positions.getZ(i))
        )
          throw new Error(`${file.name} contains invalid vertices.`);
      const material = Array.isArray(object.material) ? object.material[0] : object.material;
      const color =
        material && 'color' in material ? (material.color as Color).getHexString() : 'c5c2b8';
      const name =
        object.name ||
        object.parent?.name ||
        `${file.name.replace(/\.[^.]+$/, '')}${meshIndex ? ` ${meshIndex + 1}` : ''}`;
      const part: Part = {
        id: uid(),
        name,
        geometry,
        position: [0, 0, 0],
        quaternion: [0, 0, 0, 1],
        scale: [1, 1, 1],
        color: `#${color}`,
        visible: true,
        locked: false,
        source: file.name,
      };
      // Scans often bake large scanner coordinates into vertices. Rebase each
      // mesh without changing its world placement so local transforms stay useful.
      geometry.computeBoundingBox();
      const center = geometry.boundingBox!.getCenter(new Vector3());
      geometry.translate(-center.x, -center.y, -center.z);
      results.push(
        transformFromMatrix(
          part,
          correction
            .clone()
            .multiply(object.matrixWorld)
            .multiply(new Matrix4().makeTranslation(center.x, center.y, center.z)),
        ),
      );
      meshIndex++;
    });
  }
  if (!results.length) throw new Error('No triangle meshes were found in these files.');
  if (options.center) {
    const bounds = sceneBounds(results),
      center = bounds.getCenter(new Vector3());
    const offset = new Vector3(-center.x, -bounds.min.y, -center.z);
    for (const part of results) part.position = new Vector3(...part.position).add(offset).toArray();
  }
  return results;
}

function meshGroup(parts: Part[]) {
  const group = new Group();
  for (const part of parts) {
    const material = new MeshStandardMaterial({
      color: part.color,
      roughness: 0.68,
      metalness: 0.12,
      vertexColors: !!part.geometry.getAttribute('color'),
    });
    const mesh = new Mesh(part.geometry, material);
    mesh.name = part.name;
    mesh.matrix.copy(partMatrix(part));
    mesh.matrixAutoUpdate = false;
    mesh.userData = { kitbasherId: part.id, locked: part.locked };
    group.add(mesh);
  }
  group.updateMatrixWorld(true);
  return group;
}

export async function exportGlb(scene: SceneDocument, parts: Part[]): Promise<ArrayBuffer> {
  const root = meshGroup(parts);
  const included = sceneSubset(scene, parts);
  root.name = scene.name;
  root.scale.setScalar(0.001);
  root.userData = {
    units: 'meters',
    kitbasherJoints: included.joints,
    kitbasherPlaneConstraints: included.constraints ?? [],
  };
  try {
    const result = await new GLTFExporter().parseAsync(root, { binary: true, onlyVisible: false });
    if (!(result instanceof ArrayBuffer))
      throw new Error('GLB export did not produce a binary file.');
    return result;
  } finally {
    root.traverse((o) => {
      if (o instanceof Mesh) (o.material as MeshStandardMaterial).dispose();
    });
  }
}

export function exportStl(parts: Part[]): ArrayBuffer {
  // STL facet normals follow triangle winding, which a mirrored transform reverses.
  const baked: BufferGeometry[] = [];
  const root = meshGroup(
    parts.map((part): Part => {
      if (!isMirrored(part)) return part;
      const geometry = bakedPartGeometry(part);
      baked.push(geometry);
      return { ...part, geometry, position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] };
    }),
  );
  root.rotation.x = Math.PI / 2;
  root.updateMatrixWorld(true);
  try {
    const data = new STLExporter().parse(root, { binary: true });
    return data.buffer as ArrayBuffer;
  } finally {
    baked.forEach((geometry) => geometry.dispose());
    root.traverse((o) => {
      if (o instanceof Mesh) (o.material as MeshStandardMaterial).dispose();
    });
  }
}

export function export3mf(scene: SceneDocument, parts: Part[]): Uint8Array {
  const resources = parts.map((part, index) => {
    const data = serializeGeometry(part.geometry),
      indices = data.indices ?? Array.from({ length: data.positions.length / 3 }, (_, i) => i);
    const vertices: string[] = [],
      triangles: string[] = [];
    for (let i = 0; i < data.positions.length; i += 3)
      vertices.push(
        `<vertex x="${data.positions[i]}" y="${data.positions[i + 1]}" z="${data.positions[i + 2]}"/>`,
      );
    for (let i = 0; i < indices.length; i += 3)
      triangles.push(
        `<triangle v1="${indices[i]}" v2="${indices[i + 1]}" v3="${indices[i + 2]}"/>`,
      );
    return `<object id="${index + 1}" type="model" name="${xml(part.name)}"><mesh><vertices>${vertices.join('')}</vertices><triangles>${triangles.join('')}</triangles></mesh></object>`;
  });
  const items = parts.map((part, i) => {
    // 3MF uses row-vector affine transforms, 12 values in row-major order.
    const e = new Matrix4().makeRotationX(Math.PI / 2).multiply(partMatrix(part)).elements;
    return `<item objectid="${i + 1}" transform="${[e[0], e[1], e[2], e[4], e[5], e[6], e[8], e[9], e[10], e[12], e[13], e[14]].join(' ')}"/>`;
  });
  const model = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata name="Title">${xml(scene.name)}</metadata><metadata name="Application">Kitbasher</metadata><resources>${resources.join('')}</resources><build>${items.join('')}</build></model>`;
  return zipSync(
    {
      '[Content_Types].xml': strToU8(
        '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>',
      ),
      '_rels/.rels': strToU8(
        '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>',
      ),
      '3D/3dmodel.model': strToU8(model),
    },
    { level: 6 },
  );
}

export async function exportBlenderPackage(scene: SceneDocument, parts: Part[]) {
  const glb = await exportGlb(scene, parts);
  const joints = scene.joints.filter(
    (j) => parts.some((p) => p.id === j.childId) && parts.some((p) => p.id === j.parentId),
  );
  const transforms = Object.fromEntries(
    parts.map((part) => [
      part.id,
      {
        position: part.position,
        quaternion: part.quaternion,
        scale: part.scale,
        locked: part.locked,
        visible: part.visible,
      },
    ]),
  );
  const script = `"""Run in Blender's Scripting workspace. Imports the included GLB and rebuilds joint parenting."""
import bpy, json, os
from mathutils import Matrix, Vector, Quaternion
folder = os.path.dirname(bpy.data.filepath) if bpy.data.filepath else os.path.expanduser("~")
if "__file__" in globals():
    folder = os.path.dirname(os.path.abspath(__file__))
path = os.path.join(folder, "assembly.glb")
if not os.path.exists(path):
    raise FileNotFoundError("Set folder to the extracted Kitbasher export folder: " + folder)
assembly_scene = bpy.data.scenes.new(${JSON.stringify(scene.name)})
bpy.context.window.scene = assembly_scene
bpy.ops.import_scene.gltf(filepath=path)
bpy.context.scene.unit_settings.system = 'METRIC'
bpy.context.scene.unit_settings.length_unit = 'MILLIMETERS'
objects = {obj.get("kitbasherId"): obj for obj in bpy.context.selected_objects if obj.type == 'MESH'}
bpy.context.view_layer.update()
original_world = {key: obj.matrix_world.copy() for key, obj in objects.items()}
transforms = json.loads(${JSON.stringify(JSON.stringify(transforms))})
joints = json.loads(${JSON.stringify(JSON.stringify(joints))})
axis_conversion = Matrix(((1, 0, 0), (0, 0, -1), (0, 1, 0)))
for joint in joints:
    parent = objects.get(joint['parentId'])
    child = objects.get(joint['childId'])
    if not parent or not child:
        continue
    child['kitbasherJoint'] = json.dumps(joint)
    if not joint.get('keepConnected', True):
        continue
    # Compute anchors from the original editor coordinates. Blender's glTF
    # importer may bake axis changes into meshes, so local mesh axes vary.
    data = transforms[joint['parentId']]
    x, y, z, w = data['quaternion']
    parent_rotation = Quaternion((w, x, y, z))
    local_anchor = Vector(tuple(a * s for a, s in zip(joint['parentAnchor'], data['scale'])))
    editor_anchor = Vector(data['position']) + parent_rotation @ local_anchor
    anchor_position = (axis_conversion @ editor_anchor) * 0.001
    x, y, z, w = joint['restRotation']
    editor_rotation = (parent_rotation @ Quaternion((w, x, y, z))).to_matrix()
    anchor_rotation = (axis_conversion @ editor_rotation @ axis_conversion.inverted()).to_quaternion()
    anchor = bpy.data.objects.new(joint['name'], None)
    bpy.context.collection.objects.link(anchor)
    anchor.empty_display_type = 'SPHERE'
    anchor.empty_display_size = 0.002
    anchor.show_in_front = True
    anchor.show_name = True
    anchor.parent = parent
    anchor_world = Matrix.LocRotScale(anchor_position, anchor_rotation, Vector((1, 1, 1)))
    anchor.matrix_parent_inverse = parent.matrix_world.inverted() @ anchor_world
    anchor.matrix_basis = Matrix.Identity(4)
    anchor.rotation_mode = 'XYZ'
    locks = joint['rotationLocks']
    anchor.lock_location = (True, True, True)
    anchor.lock_rotation = (locks[0], locks[2], locks[1])
    anchor.lock_scale = (True, True, True)
    anchor['kitbasherJoint'] = json.dumps(joint)
    bpy.context.view_layer.update()
    world = original_world[joint['childId']]
    child.parent = anchor
    child.rotation_mode = 'XYZ'
    # Rotation belongs to the pivot, so the surface anchor stays connected.
    # The mesh is a fixed offset from that pivot, rather than its own rotation origin.
    child.matrix_parent_inverse = anchor.matrix_world.inverted() @ world
    child.matrix_basis = Matrix.Identity(4)
    child.lock_location = (True, True, True)
    child.lock_rotation = (True, True, True)
    child.lock_scale = (True, True, True)
    child['kitbasherJoint'] = json.dumps(joint)
for key, obj in objects.items():
    data = transforms[key]
    if data['locked']:
        obj.lock_location = (True, True, True)
        obj.lock_rotation = (True, True, True)
        obj.lock_scale = (True, True, True)
    obj.hide_set(not data['visible'])
    obj.hide_render = not data['visible']
bpy.context.view_layer.update()
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(folder, "assembly.blend"))
print("Saved", bpy.data.filepath)
`;
  const readme =
    'KITBASHER → BLENDER\n\nImport assembly.glb in Blender for separate meshes at real-world scale.\nTo also reconstruct joint parenting and rotation locks: extract this ZIP,\nopen import_assembly.py in Blender’s Scripting workspace, and run it.\nThe script saves assembly.blend in this folder.\n\nTo pose a connected part, select its named joint empty (for example, Neck pivot)\nand rotate around an unlocked local axis. Only joints with Keep connected on\nare rebuilt as pivots; disabled joints retain metadata and leave meshes free.\nThe mesh follows the pivot with\nits original anchor connected. Connected mesh transforms are locked.\n\nGLB retains names and colors; multipart 3MF retains geometry and placement.\nPlane constraints are exported as solved placement and GLB metadata. They do not become live Blender constraints.\nThe .kitbash scene is the authoritative editable scene with all joint and plane constraint data.\n';
  return zipSync(
    {
      'assembly.glb': new Uint8Array(glb),
      'import_assembly.py': strToU8(script),
      'README.txt': strToU8(readme),
    },
    { level: 6 },
  );
}

export function modelDimensions(parts: Part[]) {
  return parts.length
    ? sceneBounds(parts.map((p) => ({ ...p, visible: true }))).getSize(new Vector3())
    : new Vector3();
}
