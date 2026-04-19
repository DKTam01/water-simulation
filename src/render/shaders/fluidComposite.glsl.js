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
uniform float u_floorY;            // world-space Y of the tank floor (for refraction clamping)

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

// Brightness / saturation (reference-style cyan water)
uniform float u_tintMix;           // how strongly water tint + scatter apply (was hardcoded ~0.35)
uniform float u_scatterStrength;   // volumetric cyan/white scatter in thick regions
uniform float u_surfaceExposure;   // gentle lift on lit water before Fresnel

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
// Closest face normal in local space (axis-aligned bounding box).
// Matches SebLague's CalculateClosestFaceNormal().
// ---------------------------------------------------------------------------
vec3 closestFaceNormal(vec3 halfSize, vec3 localPos) {
    vec3 o = halfSize - abs(localPos);
    if (o.x < o.y && o.x < o.z)      return vec3(sign(localPos.x), 0.0, 0.0);
    else if (o.y < o.z)              return vec3(0.0, sign(localPos.y), 0.0);
    else                              return vec3(0.0, 0.0, sign(localPos.z));
}

// ---------------------------------------------------------------------------
// Stage 1: Smooth out normals near the fluid bounding box walls.
// Based on SebLague's SmoothEdgeNormals():
//   - When the hit point is close to a face, lerp toward the outward face normal.
//   - Corner dampening: reduce the blend where two walls meet so corners
//     don't get a weird flat patch.
// Returns vec4(blendedNormal, faceWeight) for use in Stage 2.
// ---------------------------------------------------------------------------
vec4 smoothEdgeNormals(vec3 normal, vec3 worldHitPos) {
    vec3 localPos  = worldHitPos - u_boundsCenter;
    vec3 o = u_boundsHalfSize - abs(localPos);  // positive = inside

    // Face weight: proximity to nearest XZ wall (ignore Y for cleaner top surface)
    float faceWeight = max(0.0, min(o.x, o.z));
    vec3 faceNormalLocal = closestFaceNormal(u_boundsHalfSize, localPos);

    // Transform face normal to view space for blending.
    vec3 faceNormalView = normalize((u_inverseView * vec4(faceNormalLocal, 0.0)).xyz);
    if (faceNormalView.z < 0.0) faceNormalView = -faceNormalView;

    const float smoothDst = 0.01;
    // Corner dampening: reduce blend where two walls meet (like Seb's cornerWeight)
    float cornerWeight = 1.0 - clamp(abs(o.x - o.z) * 6.0, 0.0, 1.0);
    faceWeight = 1.0 - smoothstep(0.0, smoothDst, faceWeight);
    faceWeight *= (1.0 - cornerWeight);

    vec3 blended = normalize(normal * (1.0 - faceWeight) + faceNormalView * faceWeight);
    return vec4(blended, faceWeight);
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

// ---------------------------------------------------------------------------
// Anti-aliased environment sampling — 3×3 jitter pattern (SebLague).
// Softens harsh aliasing on reflected sky and refracted floor by averaging
// 9 slightly offset samples around the main direction.
// ---------------------------------------------------------------------------
vec3 sampleEnvironmentAA(vec3 worldDir) {
    // Build a tangent frame from the direction
    vec3 up = abs(worldDir.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    vec3 right = normalize(cross(up, worldDir));
    up = cross(worldDir, right);

    float jitter = 0.7 / u_resolution.x; // ~0.7 pixel offset
    vec3 sum = vec3(0.0);
    for (int ox = -1; ox <= 1; ox++) {
        for (int oy = -1; oy <= 1; oy++) {
            vec3 offset = (right * float(ox) + up * float(oy)) * jitter;
            sum += sampleEnvironment(normalize(worldDir + offset));
        }
    }
    return sum / 9.0;
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

    // ---- No fluid at this pixel — show background --------------------------------
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

    // ---- Edge normal smoothing at tank walls (SebLague two-stage) -----------
    // Stage 1: compute wall-blended normal with corner dampening
    vec4 edgeResult = smoothEdgeNormals(normal, worldHitPos);
    vec3 edgeNormal = edgeResult.xyz;
    // Stage 2: additive blend weighted by agreement (convex awareness)
    // Only applies when surface normal agrees with the edge-smoothed direction,
    // preserving concave wave crests near walls.
    normal = normalize(normal + edgeNormal * 6.0 * max(0.0, dot(normal, edgeNormal)));

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
    vec3 skyCol = sampleEnvironmentAA(worldReflectDir);

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

    // ---- Refraction floor clamp (SebLague) ----------------------------------
    // Clamp exit point so the refracted ray doesn't sample below the tank floor.
    // Convert exit point to world space, clamp Y, convert back.
    vec3 exitWorldPos = (u_inverseView * vec4(exitViewPos, 1.0)).xyz;
    if (refractDir.y != 0.0) {
        float belowFloor = u_floorY - exitWorldPos.y;
        if (belowFloor > 0.0) {
            // Push exit point up along the refract direction to meet the floor
            vec3 refractDirWorld = normalize((u_inverseView * vec4(refractDir, 0.0)).xyz);
            if (refractDirWorld.y != 0.0) {
                exitWorldPos += refractDirWorld * (belowFloor / refractDirWorld.y);
            }
        }
    }
    // Convert clamped world position back to view space for projection.
    // u_inverseView is the camera matrixWorld. For a rigid body transform,
    // view = transpose(R) * (pos - translation).
    mat3 camR = mat3(u_inverseView);
    vec3 camT = u_inverseView[3].xyz;
    exitViewPos = transpose(camR) * (exitWorldPos - camT);

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

    // Volumetric scatter: adds bright cyan/white in fluid volume (not just dark floor)
    vec3 scatter = u_shallowColor * (1.0 - exp(-thickness * 4.5)) * u_scatterStrength;

    // ---- Half-lambert diffuse shading (SebLague style) ----------------------
    // Gives the water body/color variation across the surface — lit areas are
    // brighter, shadowed areas are darker. Without this the water looks flat.
    float halfLambert = dot(normal, u_lightDirView) * 0.5 + 0.5;
    const float ambientFloor = 0.3;
    float shading = halfLambert * (1.0 - ambientFloor) + ambientFloor;

    // ---- Blinn-Phong specular -----------------------------------------------
    vec3 halfVec = normalize(u_lightDirView + viewDir);
    float spec   = pow(max(dot(normal, halfVec), 0.0), 96.0) * u_specularStrength;

    // ---- Final composite: refracted base + tint + scatter + Fresnel + spec --
    vec3 waterBase = mix(refracted, refracted * waterTint + scatter, u_tintMix);
    waterBase *= shading * u_surfaceExposure;
    vec3 color     = mix(waterBase, skyCol, clamp(fresnel, 0.0, 1.0)) + vec3(spec);

    // ---- Foam overlay: velocity-driven white foam on top of liquid ----------
    float foam = texture2D(u_foamTexture, vUv).r;
    foam = clamp(foam, 0.0, 1.0);
    // Foam is brightest near the surface (thin regions) and on fast splashes.
    color = mix(color, vec3(1.0), foam);

    gl_FragColor = vec4(color, 1.0);
}
`;
