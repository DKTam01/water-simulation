// Separable bilateral blur for the fluid depth buffer.
// A bilateral filter preserves edges by weighting samples by both spatial distance AND
// depth similarity — preventing depth values from bleeding across fluid boundaries.
//
// Supports two modes:
//   mode 0 (depth blur):     self-referencing — uses center/sample depth for range weighting
//   mode 1 (thickness blur): uses a separate depth texture as a range reference (SebLague
//                             SmoothThickPrepare approach), preventing thickness from
//                             bleeding across depth discontinuities.
//
// Also supports screen-space adaptive blur radius (SebLague): particles close to the
// camera get a wider blur kernel, distant particles get a narrower one.
export const blurVertex = /* glsl */`
varying vec2 vUv;
void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const blurFragment = /* glsl */`
uniform sampler2D u_depthTexture;
uniform sampler2D u_rangeRefTexture; // depth texture used as bilateral range reference (mode 1)
uniform vec2 u_direction;      // (1,0) for horizontal, (0,1) for vertical
uniform vec2 u_resolution;
uniform float u_blurRadius;    // tap spacing multiplier (1 = 1 texel per step)
uniform float u_blurDepthFalloff; // bilateral range kernel sharpness
uniform int u_blurMode;        // 0 = depth blur (self-ref), 1 = thickness blur (ext depth ref)

// Screen-space adaptive blur (SebLague)
uniform float u_worldRadius;        // world-space blur radius (0 = use fixed u_blurRadius)
uniform float u_projScale;          // projection matrix ._m00 (for screen-space calc)
uniform int u_maxScreenSpaceRadius; // cap on kernel half-width in pixels

varying vec2 vUv;

void main() {
    float centerValue = texture2D(u_depthTexture, vUv).r;

    // For depth mode, get the range reference from the sample itself.
    // For thickness mode, use the separate depth texture as range reference.
    float centerDepthRef = (u_blurMode == 1)
        ? texture2D(u_rangeRefTexture, vUv).r
        : centerValue;

    // Empty pixel — check if any immediate neighbor has depth (gap-fill seed).
    // Only for depth mode; thickness mode doesn't need gap-filling.
    if (u_blurMode == 0 && centerValue < 0.001) {
        vec2 texelSize = u_direction / u_resolution;
        float n1 = texture2D(u_depthTexture, vUv + texelSize * u_blurRadius).r;
        float n2 = texture2D(u_depthTexture, vUv - texelSize * u_blurRadius).r;
        if (n1 > 0.001 && n2 > 0.001) {
            // Both neighbors have depth — we're in a gap. Seed with average.
            centerValue = (n1 + n2) * 0.5;
            centerDepthRef = centerValue;
        } else {
            gl_FragColor = vec4(0.0);
            return;
        }
    }

    // For thickness mode, skip pixels with no depth reference
    if (u_blurMode == 1 && centerDepthRef < 0.001) {
        gl_FragColor = vec4(centerValue, 0.0, 0.0, 1.0);
        return;
    }

    // ---- Compute blur kernel radius ----
    int halfRadius = 7; // default fixed
    float sigma = 1.0 / 0.09; // match original spatial weight

    if (u_worldRadius > 0.001 && centerDepthRef > 0.001) {
        // Screen-space adaptive radius (SebLague):
        // pxPerMeter = (imageWidth * projScale) / (2 * depth)
        float imageWidth = (u_direction.x > 0.5) ? u_resolution.x : u_resolution.y;
        float pxPerMeter = (imageWidth * u_projScale) / (2.0 * centerDepthRef);
        float radiusFloat = abs(pxPerMeter) * u_worldRadius;
        halfRadius = int(ceil(radiusFloat));
        if (halfRadius <= 1) halfRadius = 2;
        halfRadius = min(halfRadius, u_maxScreenSpaceRadius);
        // Sigma from fractional radius for smooth transitions
        float fR = max(0.0, float(halfRadius) - radiusFloat);
        sigma = max(0.0000001, (float(halfRadius) - fR) / 6.0);
    }

    vec2 texelSize = u_direction / u_resolution;
    float totalWeight = 0.0;
    float result = 0.0;

    for (int i = -15; i <= 15; i++) {
        if (i < -halfRadius || i > halfRadius) continue;

        vec2 sampleUV = vUv + texelSize * float(i) * u_blurRadius;
        float sampleValue = texture2D(u_depthTexture, sampleUV).r;

        float spatialW = (u_worldRadius > 0.001)
            ? exp(-float(i * i) / (2.0 * sigma * sigma))
            : exp(-float(i * i) * 0.09);

        // Get depth reference for this sample
        float sampleDepthRef = (u_blurMode == 1)
            ? texture2D(u_rangeRefTexture, sampleUV).r
            : sampleValue;

        // Gap-fill: empty neighbors near a valid center contribute the center
        // value at a heavily reduced weight (depth mode only).
        if (u_blurMode == 0 && sampleValue < 0.001) {
            float gapW = spatialW * 0.15;
            result += centerValue * gapW;
            totalWeight += gapW;
            continue;
        }

        float depthDiff = sampleDepthRef - centerDepthRef;
        float rangeW = exp(-depthDiff * depthDiff * u_blurDepthFalloff);
        float w = spatialW * rangeW;

        result += sampleValue * w;
        totalWeight += w;
    }

    float blurred = totalWeight > 0.001 ? result / totalWeight : centerValue;
    gl_FragColor = vec4(blurred, 0.0, 0.0, 1.0);
}
`;
