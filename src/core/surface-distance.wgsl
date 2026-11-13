struct Node {
  low: vec3f, skip: u32,
  high: vec3f, offset: u32,
  count: u32, pad0: u32, pad1: u32, pad2: u32,
}
struct Params { count: u32, nodes: u32, range: f32, pad: u32 }
@group(0) @binding(0) var<storage, read> nodes: array<Node>;
@group(0) @binding(1) var<storage, read> positions: array<f32>;
@group(0) @binding(2) var<storage, read> indices: array<u32>;
@group(0) @binding(3) var<storage, read> queries: array<f32>;
@group(0) @binding(4) var<storage, read_write> distances: array<f32>;
@group(0) @binding(5) var<uniform> params: Params;

fn vertex(i: u32) -> vec3f {
  return vec3f(positions[i*3u], positions[i*3u+1u], positions[i*3u+2u]);
}
fn segment(p: vec3f, a: vec3f, b: vec3f) -> f32 {
  let edge = b-a;
  let length = dot(edge,edge);
  var t = 0.0;
  if (length > 0.0) { t = clamp(dot(p-a,edge)/length,0.0,1.0); }
  let delta = p-a-t*edge;
  return dot(delta,delta);
}
fn triangle(p: vec3f, a: vec3f, b: vec3f, c: vec3f) -> f32 {
  var best = min(segment(p,a,b),min(segment(p,b,c),segment(p,c,a)));
  let normal = cross(b-a,c-a);
  let area = dot(normal,normal);
  if (area > 1e-30) {
    let height = dot(p-a,normal);
    let q = p-normal*(height/area);
    if (dot(cross(b-a,q-a),normal)>=0.0 && dot(cross(c-b,q-b),normal)>=0.0 &&
        dot(cross(a-c,q-c),normal)>=0.0) { best = min(best,height*height/area); }
  }
  return best;
}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) invocation: vec3u) {
  let i = invocation.x;
  if (i >= params.count) { return; }
  let p = vec3f(queries[i*3u],queries[i*3u+1u],queries[i*3u+2u]);
  var best = params.range*params.range;
  var n = 0u;
  // Threaded preorder traversal has no fixed stack limit. skip points past the subtree.
  while (n < params.nodes) {
    let node = nodes[n];
    let delta = max(max(node.low-p,p-node.high),vec3f(0.0));
    if (dot(delta,delta) > best) { n=node.skip; continue; }
    if (node.count == 0u) { n+=1u; continue; }
    for (var t=node.offset; t<node.offset+node.count; t+=1u) {
      best=min(best,triangle(p,vertex(indices[t*3u]),vertex(indices[t*3u+1u]),vertex(indices[t*3u+2u])));
    }
    n=node.skip;
  }
  distances[i]=sqrt(best);
}
