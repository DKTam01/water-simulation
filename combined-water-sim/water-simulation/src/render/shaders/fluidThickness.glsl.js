// Same billboard technique as the depth pass but with additive blending.
// Each particle contributes its chord length (diameter through sphere at this screen position)
// to the thickness buffer, so overlapping particles accumulate correctly.
export const thicknessVertex = /* glsl */`
uniform sampler2D texturePosition;
uniform sampler2D textureDensity;
attribute vec2 particleUV;
uniform float u_particleRadius;
uniform float u_targetDensity;
uniform float u_densityRadiusStrength;

varying vec2 vQuadPos;

void main() {
    vec3 worldCenter = texture2D(texturePosition, particleUV).xyz;
    float dens = max(texture2D(textureDensity, particleUV).r, 0.001);
    float ratio = u_targetDensity / dens;
    float radiusScale = clamp(pow(ratio, 0.5), 0.8, 2.5);
    radiusScale = mix(1.0, radiusScale, clamp(u_densityRadiusStrength, 0.0, 1.0));
    float r = u_particleRadius * radiusScale;
    vec4 viewCenter = viewMatrix * vec4(worldCenter, 1.0);
    vec4 viewPos = viewCenter + vec4(position.xy * r, 0.0, 0.0);
    vQuadPos = position.xy;
    gl_Position = projectionMatrix * viewPos;
}
`;

// Each particle contributes a flat constant to the thickness buffer.
// Using a constant (instead of the chord length) avoids per-sphere bumps
// that make individual particles visible in the thickness channel — the
// exact fix SebLague uses to get smooth, continuous fluid thickness.
export const thicknessFragment = /* glsl */`
uniform float u_thicknessScale;

varying vec2 vQuadPos;

void main() {
    float r2 = dot(vQuadPos, vQuadPos);
    if (r2 > 1.0) discard;
    gl_FragColor = vec4(u_thicknessScale, 0.0, 0.0, 1.0);
}
`;
