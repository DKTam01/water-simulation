// Billboard quads that splat foam intensity based on particle speed.
// Fast-moving particles near the surface produce white foam; slow interior
// particles produce none.  Uses additive blending so overlapping splats
// accumulate into dense foam regions.
export const foamVertex = /* glsl */`
uniform sampler2D texturePosition;
uniform sampler2D textureVelocity;
attribute vec2 particleUV;
uniform float u_particleRadius;
uniform float u_foamSpeedMin;   // below this speed, no foam
uniform float u_foamSpeedMax;   // above this speed, full foam

varying vec2 vQuadPos;
varying float vFoamIntensity;

void main() {
    vec3 worldCenter = texture2D(texturePosition, particleUV).xyz;
    vec3 vel         = texture2D(textureVelocity, particleUV).xyz;
    float speed      = length(vel);

    // Ramp: 0 below min, 1 above max
    vFoamIntensity = smoothstep(u_foamSpeedMin, u_foamSpeedMax, speed);

    vec4 viewCenter = viewMatrix * vec4(worldCenter, 1.0);
    vec4 viewPos    = viewCenter + vec4(position.xy * u_particleRadius, 0.0, 0.0);
    vQuadPos = position.xy;
    gl_Position = projectionMatrix * viewPos;
}
`;

export const foamFragment = /* glsl */`
uniform float u_foamScale;

varying vec2 vQuadPos;
varying float vFoamIntensity;

void main() {
    float r2 = dot(vQuadPos, vQuadPos);
    if (r2 > 1.0) discard;

    // Soft-edged splat with radial falloff
    float alpha = (1.0 - r2) * vFoamIntensity * u_foamScale;
    gl_FragColor = vec4(alpha, 0.0, 0.0, 1.0);
}
`;
