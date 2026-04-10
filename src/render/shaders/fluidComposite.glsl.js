export const compositeVertex = /* glsl */`
varying vec2 vUv;
void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const compositeFragment = /* glsl */`
uniform sampler2D u_sceneColor;
uniform sampler2D u_fluidDepth;       // heavily blurred depth (smooth surface)
uniform sampler2D u_fluidDepthRaw;    // raw/unblurred depth (fine detail)
uniform sampler2D u_fluidThickness;
uniform float u_detailNormalBlend;    // 0 = pure smooth, 1 = pure raw detail
uniform vec2 u_resolution;
uniform float u_near;
uniform float u_far;
uniform mat4 u_inverseProjection;
uniform mat4 u_inverseView;       // camera matrixWorld (view-to-world)
uniform mat4 u_cameraProjection;  // scene camera projection matrix (for exit-point reprojection)

// Water look parameters
uniform vec3 u_waterColor;         // deep water tint (applied to thick regions)
uniform vec3 u_shallowColor;      // thin-edge tint (bright teal)
uniform vec3 u_absorptionColor;    // per-channel Beer-Lambert extinction coefficients
uniform float u_absorptionStrength;
uniform float u_ior;               // index of refraction (default 1.33 for water)
uniform float u_refractionStrength;
uniform float u_specularStrength;
uniform float u_normalScale;
uniform vec3 u_lightDirView;       // light direction in view space

// Tank bounding box in world space — used for edge normal smoothing.
// boundsHalfSize = boxSize (half-size, since tank is centred at boundsCenter).
uniform vec3 u_boundsCenter;
uniform vec3 u_boundsHalfSize;

// Environment cubemap for reflections (PMREM-filtered).
uniform samplerCube u_envMap;
uniform float u_envMapIntensity;

// Foam
uniform sampler2D u_foamTexture;

// Floor caustics
uniform float u_causticsStrength;

// Debug: 0=final, 1=depth, 2=thickness, 3=normals, 4=foam
uniform float u_debugMode;

varying vec2 vUv;

// ---------------------------------------------------------------------------
// Reconstruct view-space position from UV + linear (positive) view depth.
// ---------------------------------------------------------------------------
vec3 viewPosFromDepth(vec2 uv, float linearDepth) {
    vec4 ndc = vec4(uv * 2.0 - 1.0, -1.0, 1.0);
    vec4 viewH = u_inverseProjection * ndc;
    viewH.xyz /= viewH.w;
    return viewH.xyz * (linearDepth / (-viewH.z));
}

// ---------------------------------------------------------------------------
// Normal reconstruction — min-abs forward/backward selection per axis.
// This is the exact technique from SebLague's NormalsFromDepth.shader:
// compare the forward and backward difference, use the one with the smaller
// absolute z-delta so that fluid boundary pixels don't blow up.
// ---------------------------------------------------------------------------
vec3 reconstructNormal(vec2 uv, float d0) {
    vec2 ts = 1.0 / u_resolution;

    vec3 p0 = viewPosFromDepth(uv, d0);

    // X axis: forward (+x) and backward (-x)
    float dxF = texture2D(u_fluidDepth, uv + vec2(ts.x, 0.0)).r;
    float dxB = texture2D(u_fluidDepth, uv - vec2(ts.x, 0.0)).r;
    if (dxF < 0.001) dxF = d0;
    if (dxB < 0.001) dxB = d0;
    vec3 ddxF = viewPosFromDepth(uv + vec2(ts.x, 0.0), dxF) - p0;
    vec3 ddxB = p0 - viewPosFromDepth(uv - vec2(ts.x, 0.0), dxB);
    vec3 ddx  = (abs(ddxB.z) < abs(ddxF.z)) ? ddxB : ddxF;

    // Y axis: forward (+y) and backward (-y)
    float dyF = texture2D(u_fluidDepth, uv + vec2(0.0, ts.y)).r;
    float dyB = texture2D(u_fluidDepth, uv - vec2(0.0, ts.y)).r;
    if (dyF < 0.001) dyF = d0;
    if (dyB < 0.001) dyB = d0;
    vec3 ddyF = viewPosFromDepth(uv + vec2(0.0, ts.y), dyF) - p0;
    vec3 ddyB = p0 - viewPosFromDepth(uv - vec2(0.0, ts.y), dyB);
    vec3 ddy  = (abs(ddyB.z) < abs(ddyF.z)) ? ddyB : ddyF;

    // Amplify for more visible surface detail; cross product gives the normal.
    return normalize(cross(ddy * u_normalScale, ddx * u_normalScale));
}

// Same as above but reads from the raw (unblurred) depth texture.
vec3 reconstructNormalRaw(vec2 uv, float d0) {
    vec2 ts = 1.0 / u_resolution;
    vec3 p0 = viewPosFromDepth(uv, d0);

    float dxF = texture2D(u_fluidDepthRaw, uv + vec2(ts.x, 0.0)).r;
    float dxB = texture2D(u_fluidDepthRaw, uv - vec2(ts.x, 0.0)).r;
    if (dxF < 0.001) dxF = d0;
    if (dxB < 0.001) dxB = d0;
    vec3 ddxF = viewPosFromDepth(uv + vec2(ts.x, 0.0), dxF) - p0;
    vec3 ddxB = p0 - viewPosFromDepth(uv - vec2(ts.x, 0.0), dxB);
    vec3 ddx  = (abs(ddxB.z) < abs(ddxF.z)) ? ddxB : ddxF;

    float dyF = texture2D(u_fluidDepthRaw, uv + vec2(0.0, ts.y)).r;
    float dyB = texture2D(u_fluidDepthRaw, uv - vec2(0.0, ts.y)).r;
    if (dyF < 0.001) dyF = d0;
    if (dyB < 0.001) dyB = d0;
    vec3 ddyF = viewPosFromDepth(uv + vec2(0.0, ts.y), dyF) - p0;
    vec3 ddyB = p0 - viewPosFromDepth(uv - vec2(0.0, ts.y), dyB);
    vec3 ddy  = (abs(ddyB.z) < abs(ddyF.z)) ? ddyB : ddyF;

    return normalize(cross(ddy * u_normalScale, ddx * u_normalScale));
}

// ---------------------------------------------------------------------------
// Smooth out normals near the fluid bounding box walls.
// Based on SebLague's SmoothEdgeNormals(): when the hit point is very close
// to a face, blend the surface normal toward the outward face normal.
// This prevents the hard, noisy silhouette where fluid meets tank walls.
// ---------------------------------------------------------------------------
vec3 smoothEdgeNormals(vec3 normal, vec3 worldHitPos) {
    vec3 localPos  = worldHitPos - u_boundsCenter;
    vec3 distToFace = u_boundsHalfSize - abs(localPos);  // positive = inside

    const float smoothDst = 0.15;

    // Find closest face normal in world space (axis-aligned tank).
    vec3 absD = abs(localPos);
    vec3 faceNormalLocal;
    if (absD.x > absD.y && absD.x > absD.z)      faceNormalLocal = vec3(sign(localPos.x), 0.0, 0.0);
    else if (absD.y > absD.z)                      faceNormalLocal = vec3(0.0, sign(localPos.y), 0.0);
    else                                            faceNormalLocal = vec3(0.0, 0.0, sign(localPos.z));

    // Transform face normal to view space for blending.
    vec3 faceNormalView = normalize((u_inverseView * vec4(faceNormalLocal, 0.0)).xyz);
    // Ensure the face normal points toward camera (+z in view space).
    if (faceNormalView.z < 0.0) faceNormalView = -faceNormalView;

    float minDist   = min(min(distToFace.x, distToFace.y), distToFace.z);
    float edgeBlend = 1.0 - smoothstep(0.0, smoothDst, minDist);

    return normalize(mix(normal, faceNormalView, edgeBlend * 0.7));
}

// ---------------------------------------------------------------------------
// Fresnel reflectance — full Fresnel equations, not Schlick (matches SebLague).
// iorA = 1.0 (air), iorB = u_ior (water, ~1.33).
// ---------------------------------------------------------------------------
float fresnelReflectance(float cosIn, float iorA, float iorB) {
    float ratio   = iorA / iorB;
    float sinSqrT = ratio * ratio * (1.0 - cosIn * cosIn);
    if (sinSqrT >= 1.0) return 1.0; // total internal reflection

    float cosT = sqrt(1.0 - sinSqrT);
    float rPerp = (iorA * cosIn  - iorB * cosT) / (iorA * cosIn  + iorB * cosT);
    float rPar  = (iorB * cosIn  - iorA * cosT) / (iorB * cosIn  + iorA * cosT);
    return (rPerp * rPerp + rPar * rPar) * 0.5;
}

// ---------------------------------------------------------------------------
// Environment reflection colour — samples the PMREM cubemap if available,
// falls back to a procedural sky gradient otherwise.
// ---------------------------------------------------------------------------
vec3 sampleEnvironment(vec3 worldDir) {
    vec3 envColor = textureCube(u_envMap, worldDir).rgb * u_envMapIntensity;
    // Fallback: if the env map is blank (e.g. not yet loaded), use procedural sky.
    float lum = dot(envColor, vec3(0.299, 0.587, 0.114));
    if (lum < 0.001) {
        const vec3 zenith  = vec3(0.08, 0.37, 0.73);
        const vec3 horizon = vec3(0.80, 0.85, 0.92);
        const vec3 ground  = vec3(0.18, 0.15, 0.18);
        float t = smoothstep(-0.05, 0.4, worldDir.y);
        float g = smoothstep(-0.05, 0.0, worldDir.y);
        envColor = mix(ground, mix(horizon, zenith, pow(t, 0.35)), g);
    }
    return envColor;
}

void main() {
    float fluidDepth = texture2D(u_fluidDepth, vUv).r;
    vec4 sceneColor  = texture2D(u_sceneColor,  vUv);

    // ---- Debug views --------------------------------------------------------
    if (u_debugMode > 0.5 && u_debugMode < 1.5) {
        float d = fluidDepth > 0.001 ? clamp(fluidDepth * 0.04, 0.0, 1.0) : 0.0;
        gl_FragColor = vec4(d, d, d, 1.0);
        return;
    }
    if (u_debugMode > 1.5 && u_debugMode < 2.5) {
        float t = texture2D(u_fluidThickness, vUv).r;
        gl_FragColor = vec4(t * 0.5, t * 0.15, 0.0, 1.0);
        return;
    }

    // ---- Debug: foam view ---------------------------------------------------
    if (u_debugMode > 3.5 && u_debugMode < 4.5) {
        float f = texture2D(u_foamTexture, vUv).r;
        gl_FragColor = vec4(f, f, f, 1.0);
        return;
    }

    // ---- No fluid at this pixel — show background --------------------------
    if (fluidDepth < 0.001) {
        gl_FragColor = sceneColor;
        return;
    }

    float thickness = max(texture2D(u_fluidThickness, vUv).r, 0.001);

    // ---- Reconstruct view-space normals from both blurred and raw depth -----
    // The blurred normals give a smooth continuous surface; the raw normals
    // preserve fine ripple detail and sparkle from real particle motion.
    vec3 normalSmooth = reconstructNormal(vUv, fluidDepth);
    if (normalSmooth.z < 0.0) normalSmooth = -normalSmooth;

    float rawDepth = texture2D(u_fluidDepthRaw, vUv).r;
    vec3 normalDetail = normalSmooth;
    if (rawDepth > 0.001 && u_detailNormalBlend > 0.001) {
        normalDetail = reconstructNormalRaw(vUv, rawDepth);
        if (normalDetail.z < 0.0) normalDetail = -normalDetail;
    }

    vec3 normal = normalize(mix(normalSmooth, normalDetail, u_detailNormalBlend));

    // ---- Reconstruct world-space hit position for edge smoothing -----------
    vec3 viewHitPos   = viewPosFromDepth(vUv, fluidDepth);
    vec3 worldHitPos  = (u_inverseView * vec4(viewHitPos, 1.0)).xyz;

    // ---- Edge normal smoothing at tank walls --------------------------------
    normal = smoothEdgeNormals(normal, worldHitPos);

    if (u_debugMode > 2.5 && u_debugMode < 3.5) {
        gl_FragColor = vec4(normal * 0.5 + 0.5, 1.0);
        return;
    }

    // ---- Per-pixel view direction (in view space, toward camera) -----------
    // viewHitPos has z < 0. The view direction is from surface to eye = -normalize(viewHitPos).
    vec3 viewDir = -normalize(viewHitPos);

    // ---- Physical Fresnel (IOR 1.0 → u_ior) --------------------------------
    float cosIn   = max(dot(normal, viewDir), 0.0);
    float fresnel = fresnelReflectance(cosIn, 1.0, u_ior);

    // ---- Sky colour for reflection ------------------------------------------
    vec3 viewReflectDir = reflect(-viewDir, normal);
    vec3 worldReflectDir = normalize((u_inverseView * vec4(viewReflectDir, 0.0)).xyz);
    vec3 skyCol = sampleEnvironment(worldReflectDir);

    // ---- Fake caustics: surface curvature → floor brightness shimmer --------
    // Approximates the Laplacian of the depth field: converging normals brighten,
    // diverging normals darken. The result modulates the refracted floor colour.
    float caustics = 0.0;
    if (u_causticsStrength > 0.001) {
        vec2 ts = 1.0 / u_resolution;
        float d0 = fluidDepth;
        float dL = texture2D(u_fluidDepth, vUv - vec2(ts.x, 0.0)).r;
        float dR = texture2D(u_fluidDepth, vUv + vec2(ts.x, 0.0)).r;
        float dD = texture2D(u_fluidDepth, vUv - vec2(0.0, ts.y)).r;
        float dU = texture2D(u_fluidDepth, vUv + vec2(0.0, ts.y)).r;
        // Replace missing neighbors with center depth to avoid edge artifacts
        if (dL < 0.001) dL = d0;
        if (dR < 0.001) dR = d0;
        if (dD < 0.001) dD = d0;
        if (dU < 0.001) dU = d0;
        float laplacian = (dL + dR + dD + dU - 4.0 * d0);
        // Amplify and map to a brightness multiplier around 1.0
        caustics = laplacian * u_causticsStrength * 80.0;
    }

    // ---- Physical refraction ------------------------------------------------
    // Compute refracted ray direction in view space, then project exit point
    // back to a screen UV to sample the scene.
    vec3 refractDir;
    float ratio = 1.0 / u_ior;
    float sinSqrT = ratio * ratio * (1.0 - cosIn * cosIn);
    if (sinSqrT < 1.0) {
        refractDir = ratio * (-viewDir) + (ratio * cosIn - sqrt(1.0 - sinSqrT)) * normal;
    } else {
        refractDir = viewReflectDir; // total internal reflection fallback
    }

    // Exit point: travel refractDir * thickness * scale through the fluid.
    vec3 exitViewPos = viewHitPos + refractDir * thickness * u_refractionStrength;
    // Project exit point back to screen UV using the scene camera projection.
    vec4 exitClip    = u_cameraProjection * vec4(exitViewPos, 1.0);
    vec2 exitNDC     = exitClip.xy / exitClip.w;
    vec2 refractUV   = clamp(exitNDC * 0.5 + 0.5, vec2(0.001), vec2(0.999));
    vec3 refractedScene = texture2D(u_sceneColor, refractUV).rgb;

    // Apply caustics shimmer to the refracted floor.
    refractedScene *= 1.0 + caustics;

    // ---- Beer-Lambert absorption --------------------------------------------
    vec3 transmission = exp(-u_absorptionColor * u_absorptionStrength * thickness);
    vec3 refracted    = refractedScene * transmission;

    // ---- Depth-dependent water tint -----------------------------------------
    // Thin edges get a bright shallow tint; thick interior gets the deep color.
    float depthBlend = 1.0 - exp(-thickness * u_absorptionStrength * 2.0);
    vec3 waterTint   = mix(u_shallowColor, u_waterColor, depthBlend);

    // ---- Blinn-Phong specular -----------------------------------------------
    vec3 halfVec = normalize(u_lightDirView + viewDir);
    float spec   = pow(max(dot(normal, halfVec), 0.0), 96.0) * u_specularStrength;

    // ---- Final composite: refracted base + tint + Fresnel + specular --------
    vec3 waterBase = mix(refracted, refracted * waterTint, 0.35);
    vec3 color     = mix(waterBase, skyCol, clamp(fresnel, 0.0, 1.0)) + vec3(spec);

    // ---- Foam overlay: velocity-driven white foam on top of liquid ----------
    float foam = texture2D(u_foamTexture, vUv).r;
    foam = clamp(foam, 0.0, 1.0);
    // Foam is brightest near the surface (thin regions) and on fast splashes.
    color = mix(color, vec3(1.0), foam);

    gl_FragColor = vec4(color, 1.0);
}
`;
