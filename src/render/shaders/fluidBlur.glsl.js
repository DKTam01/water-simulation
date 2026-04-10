// Separable bilateral blur for the fluid depth buffer.
// A bilateral filter preserves edges by weighting samples by both spatial distance AND
// depth similarity — preventing depth values from bleeding across fluid boundaries.
export const blurVertex = /* glsl */`
varying vec2 vUv;
void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const blurFragment = /* glsl */`
uniform sampler2D u_depthTexture;
uniform vec2 u_direction;      // (1,0) for horizontal, (0,1) for vertical
uniform vec2 u_resolution;
uniform float u_blurRadius;    // tap spacing multiplier (1 = 1 texel per step)
uniform float u_blurDepthFalloff; // bilateral range kernel sharpness

varying vec2 vUv;

void main() {
    float centerDepth = texture2D(u_depthTexture, vUv).r;

    // Empty pixel — check if any immediate neighbor has depth (gap-fill seed).
    // If so, adopt that neighbor's depth as our center so the blur can grow
    // the fluid surface into single-pixel holes between particles.
    if (centerDepth < 0.001) {
        vec2 texelSize = u_direction / u_resolution;
        float n1 = texture2D(u_depthTexture, vUv + texelSize * u_blurRadius).r;
        float n2 = texture2D(u_depthTexture, vUv - texelSize * u_blurRadius).r;
        if (n1 > 0.001 && n2 > 0.001) {
            // Both neighbors have depth — we're in a gap. Seed with average.
            centerDepth = (n1 + n2) * 0.5;
        } else {
            gl_FragColor = vec4(0.0);
            return;
        }
    }

    vec2 texelSize = u_direction / u_resolution;
    float totalWeight = 0.0;
    float result = 0.0;

    for (int i = -7; i <= 7; i++) {
        vec2 sampleUV = vUv + texelSize * float(i) * u_blurRadius;
        float sampleDepth = texture2D(u_depthTexture, sampleUV).r;

        float spatialW = exp(-float(i * i) * 0.09);

        // Gap-fill: empty neighbors near a valid center contribute the center
        // depth at a heavily reduced weight, letting the blur bridge small gaps.
        if (sampleDepth < 0.001) {
            float gapW = spatialW * 0.15;
            result += centerDepth * gapW;
            totalWeight += gapW;
            continue;
        }

        float depthDiff = sampleDepth - centerDepth;
        float rangeW = exp(-depthDiff * depthDiff * u_blurDepthFalloff);
        float w = spatialW * rangeW;

        result += sampleDepth * w;
        totalWeight += w;
    }

    float blurred = totalWeight > 0.001 ? result / totalWeight : centerDepth;
    gl_FragColor = vec4(blurred, 0.0, 0.0, 1.0);
}
`;
