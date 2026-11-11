// SPDX-License-Identifier: MIT
// Copyright (c) 2026 French Touch Factory / ITHACA
//
// Gaussian splat shaders (GLSL ES 3.00, three.js ShaderMaterial). One instanced quad per visible gaussian, drawn back
// to front (order from the sort worker). HD gaussian evaluation at time uTime as in the ITHACA Unity package, then the
// usual EWA projection of the 3D covariance to the screen. Layout of the four textures: see format/pack.js.

export const vertexShader = /* glsl */ `
precision highp float;
precision highp int;
precision highp usampler2D;

uniform highp sampler2D uA;
uniform usampler2D uB, uC, uD;
uniform float uTime;          // normalized video time
uniform float uShScale;       // 0: no SH
uniform vec2 uViewport;       // pixels of the view being drawn (one eye in XR)
uniform vec3 uCamPos;         // camera position in model space
uniform int uBoxMode;         // 0 none, 1 keep inside, 2 keep outside
uniform mat4 uToScene;        // model space → framed scene space (box test)
uniform vec3 uBoxCenter, uBoxHalf;
uniform float uMaxAxis;       // longest splat axis on screen (pixels)

in float splatIndex;
out vec4 vColor;
out vec2 vUv;

const float C1 = 0.4886025119029199;

float snorm8(uint u, uint s) { return (float((u >> s) & 255u) - 128.0) / 127.0; }
void cull() { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); vColor = vec4(0.0); vUv = vec2(0.0); }

void main() {
  int i = int(splatIndex);
  ivec2 uv = ivec2(i & 2047, i >> 11);
  vec4 a = texelFetch(uA, uv, 0);
  uvec4 b = texelFetch(uB, uv, 0);
  if (uTime < uintBitsToFloat(b.z) || uTime >= uintBitsToFloat(b.w)) { cull(); return; }
  vec2 vxy = unpackHalf2x16(b.x), vzd = unpackHalf2x16(b.y);
  float dt = uTime - a.w, xt = dt / vzd.y;
  uvec4 c = texelFetch(uC, uv, 0);
  vec2 szo = unpackHalf2x16(c.y);
  float alpha = szo.y * exp(-0.5 * xt * xt);
  if (alpha < 1.0 / 255.0) { cull(); return; }
  vec3 p = a.xyz + vec3(vxy, vzd.x) * dt;

  if (uBoxMode != 0) {
    vec3 q = (uToScene * vec4(p, 1.0)).xyz;
    bool inside = all(lessThanEqual(abs(q - uBoxCenter), uBoxHalf));
    if ((uBoxMode == 1) != inside) { cull(); return; }
  }

  vec4 vp = modelViewMatrix * vec4(p, 1.0);
  vec4 clip = projectionMatrix * vp;
  // near cut of the reference gaussian rasterizers: splats whose centre is closer than 0.2 model units to the camera are
  // dropped (the model was trained that way: such splats were never seen; drawn, they veil the view). In model units,
  // so it follows the scale given to the video by the host scene.
  if (-vp.z < 0.2 * length(modelViewMatrix[0].xyz)) { cull(); return; }

  // 3D covariance  Σ = R S Sᵀ Rᵀ  (quaternion x, y, z, w: three smallest components on 16 bits + index of the largest)
  vec3 sm = (vec3(float(c.z & 65535u), float(c.z >> 16), float(c.w & 65535u)) / 65535.0 * 2.0 - 1.0) * 0.70710678;
  uint im = (c.w >> 16) & 3u;
  float big = sqrt(max(0.0, 1.0 - dot(sm, sm)));
  vec4 r = im == 0u ? vec4(big, sm) : im == 1u ? vec4(sm.x, big, sm.y, sm.z) : im == 2u ? vec4(sm.x, sm.y, big, sm.z) : vec4(sm, big);
  float x = r.x, y = r.y, z = r.z, w = r.w;
  mat3 R = mat3(1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y + w * z), 2.0 * (x * z - w * y),
                2.0 * (x * y - w * z), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z + w * x),
                2.0 * (x * z + w * y), 2.0 * (y * z - w * x), 1.0 - 2.0 * (x * x + y * y));
  vec3 s = vec3(unpackHalf2x16(c.x), szo.x);
  mat3 M = mat3(R[0] * s.x, R[1] * s.y, R[2] * s.z);
  mat3 W = mat3(modelViewMatrix);
  mat3 V = W * (M * transpose(M)) * transpose(W);        // covariance in view space

  // screen-space Jacobian of the perspective projection (pixels; three.js looks down −z)
  float fx = projectionMatrix[0][0] * uViewport.x * 0.5, fy = projectionMatrix[1][1] * uViewport.y * 0.5;
  float tz = vp.z;
  float lx = 1.3 / projectionMatrix[0][0], ly = 1.3 / projectionMatrix[1][1];
  float tx = clamp(vp.x / -tz, -lx, lx) * -tz, ty = clamp(vp.y / -tz, -ly, ly) * -tz;
  vec3 j1 = vec3(fx / -tz, 0.0, fx * tx / (tz * tz));
  vec3 j2 = vec3(0.0, fy / -tz, fy * ty / (tz * tz));
  float ca = dot(j1, V * j1) + 0.3, cb = dot(j1, V * j2), cc = dot(j2, V * j2) + 0.3;

  float mid = 0.5 * (ca + cc), rad = length(vec2(0.5 * (ca - cc), cb));
  float l1 = mid + rad, l2 = max(mid - rad, 0.1);
  vec2 d = abs(cb) > 1e-9 ? normalize(vec2(cb, l1 - ca)) : (ca >= cc ? vec2(1.0, 0.0) : vec2(0.0, 1.0));
  vec2 major = min(sqrt(2.0 * l1), uMaxAxis) * d;
  vec2 minor = min(sqrt(2.0 * l2), uMaxAxis) * vec2(d.y, -d.x);

  // culled only if the whole splat is off screen (its extent, not its centre: large splats centred outside the view
  // still cover it, e.g. the background of a scene seen from inside)
  vec2 center = clip.xy / clip.w;
  vec2 extent = 2.0 * (abs(major) + abs(minor)) * 2.0 / uViewport;      // quad half-size in NDC (corners at ±2)
  if (any(greaterThan(abs(center) - extent, vec2(1.0)))) { cull(); return; }
  vec2 ndc = center + (position.x * major + position.y * minor) * 2.0 / uViewport;
  gl_Position = vec4(ndc, clip.z / clip.w, 1.0);

  // colour: SH degree 0 + 1
  uvec4 e = texelFetch(uD, uv, 0);
  vec3 col = vec3(unpackHalf2x16(e.x), unpackHalf2x16(e.y & 65535u).x);
  if (uShScale > 0.0) {
    // SH bytes q0…q8 = R1 R2 R3 G1 G2 G3 B1 B2 B3: q0 q1 in e.y (bits 16, 24), q2…q5 in e.z, q6…q8 in e.w
    vec3 dir = normalize(p - uCamPos);
    vec3 k1 = vec3(snorm8(e.y, 16u), snorm8(e.z, 8u), snorm8(e.w, 0u));
    vec3 k2 = vec3(snorm8(e.y, 24u), snorm8(e.z, 16u), snorm8(e.w, 8u));
    vec3 k3 = vec3(snorm8(e.z, 0u), snorm8(e.z, 24u), snorm8(e.w, 16u));
    col += uShScale * C1 * (-dir.y * k1 + dir.z * k2 - dir.x * k3);
  }
  vColor = vec4(clamp(col, 0.0, 1.0), alpha);   // clamped to [0, 1] like the reference gaussian rasterizers (brighter haze otherwise)
  vUv = position.xy;
}
`;

export const fragmentShader = /* glsl */ `
precision highp float;
in vec4 vColor;
in vec2 vUv;
layout(location = 0) out highp vec4 outColor;
void main() {
  float r = dot(vUv, vUv);
  if (r > 4.0) discard;
  float a = min(0.99, vColor.a * exp(-r));        // alpha cap of the rasterizers
  if (a < 1.0 / 255.0) discard;
  outColor = vec4(vColor.rgb, a);
}
`;
