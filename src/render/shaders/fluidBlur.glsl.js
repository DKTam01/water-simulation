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

    // Empty pixel — pass through zero so composite can detect fluid boundary.
    if (centerDepth < 0.001) {
        gl_FragColor = vec4(0.0);
        return;
    }

    vec2 texelSize = u_direction / u_resolution;
    float totalWeight = 0.0;
    float result = 0.0;

    // 15-tap Gaussian bilateral: i in [-7, 7]
    for (int i = -7; i <= 7; i++) {
        vec2 sampleUV = vUv + texelSize * float(i) * u_blurRadius;
        float sampleDepth = texture2D(u_depthTexture, sampleUV).r;
        if (sampleDepth < 0.001) continue; // skip empty neighbours

        float spatialW = exp(-float(i * i) * 0.09); // Gaussian spatial
        float depthDiff = sampleDepth - centerDepth;
        float rangeW = exp(-depthDiff * depthDiff * u_blurDepthFalloff); // bilateral range
        float w = spatialW * rangeW;

        result += sampleDepth * w;
        totalWeight += w;
    }

    float blurred = totalWeight > 0.001 ? result / totalWeight : centerDepth;
    gl_FragColor = vec4(blurred, 0.0, 0.0, 1.0);
}
`;
