// Billboard vertex: centers each quad on the particle's world position and expands in view space,
// so the quad is always screen-aligned regardless of camera angle.
export const depthVertex = /* glsl */`
uniform sampler2D texturePosition;
uniform sampler2D textureDensity;
attribute vec2 particleUV;
uniform float u_particleRadius;
uniform float u_targetDensity;
uniform float u_densityRadiusStrength;

varying vec2 vQuadPos;
varying vec3 vViewPos;
varying float vRadius;

void main() {
    vec3 worldCenter = texture2D(texturePosition, particleUV).xyz;
    float dens = max(texture2D(textureDensity, particleUV).r, 0.001);
    float ratio = u_targetDensity / dens;
    // Increase splat size in sparse regions to keep a continuous surface.
    float radiusScale = clamp(pow(ratio, 0.5), 0.8, 2.5);
    radiusScale = mix(1.0, radiusScale, clamp(u_densityRadiusStrength, 0.0, 1.0));
    vRadius = u_particleRadius * radiusScale;

    // Transform particle center to view space
    vec4 viewCenter = viewMatrix * vec4(worldCenter, 1.0);

    // Expand the quad in view space — this removes camera rotation,
    // making the quad always face the camera.
    // position.xy from PlaneGeometry(2,2) ranges -1..1.
    vec4 viewPos = viewCenter + vec4(position.xy * vRadius, 0.0, 0.0);

    vQuadPos = position.xy;
    vViewPos = viewPos.xyz;

    gl_Position = projectionMatrix * viewPos;
}
`;

// Fragment: discard corners outside the sphere disc, compute the analytically-correct
// front-sphere linear depth, and occlusion-test against the opaque scene's depth texture.
export const depthFragment = /* glsl */`
uniform float u_particleRadius;
uniform float u_near;
uniform float u_far;
uniform sampler2D u_sceneDepth;
uniform vec2 u_resolution;

varying vec2 vQuadPos;
varying vec3 vViewPos;
varying float vRadius;

float linearizeDepth(float hwDepth) {
    float ndc = hwDepth * 2.0 - 1.0;
    return (2.0 * u_near * u_far) / (u_far + u_near - ndc * (u_far - u_near));
}

void main() {
    float r2 = dot(vQuadPos, vQuadPos);
    if (r2 > 1.0) discard;

    // Sphere surface closest to camera at this quad position:
    //   z_surface = z_center + sqrt(1 - r²) * radius   (more +z = closer to camera)
    //   linear depth = -(z_surface) since z_view is negative for things in front
    float sphereZOffset = sqrt(1.0 - r2) * vRadius;
    float linearDepth = -(vViewPos.z + sphereZOffset);

    // Occlusion: skip fragments that are behind opaque scene geometry.
    vec2 screenUV = gl_FragCoord.xy / u_resolution;
    float hwDepth = texture2D(u_sceneDepth, screenUV).r;
    float sceneLinear = linearizeDepth(hwDepth);
    if (linearDepth >= sceneLinear) discard;

    // Pack depth into R channel; G/B/A unused.
    gl_FragColor = vec4(linearDepth, 0.0, 0.0, 1.0);
}
`;
