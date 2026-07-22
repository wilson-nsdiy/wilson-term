//! WGSL 着色器源代码
//!
//! 借鉴 wezterm `wezterm-gui/src/shader.wgsl` 的设计:
//! - 顶点着色器:接收 2D 位置 + UV 坐标 + 前景色
//! - 片段着色器:从 glyph atlas 采样纹理,混合前景色
//!
//! 本阶段只定义源代码字符串常量,实际的 wgpu ShaderModule 创建在阶段 6
//! （集成 Tauri 时）由渲染层调用 `device.create_shader_module()`。

/// 顶点着色器 WGSL 源代码
///
/// 输入:
/// - `in_pos`:2D 位置（vec2<f32>）
/// - `in_uv`:UV 坐标（vec2<f32>）
/// - `in_color`:前景色（vec4<u8>）
///
/// 输出:
/// - `out_uv`:传递 UV 坐标给片段着色器
/// - `out_color`:传递颜色给片段着色器
pub const VERTEX_SHADER_SRC: &str = r#"
struct VertexInput {
    @location(0) in_pos: vec2<f32>,
    @location(1) in_uv: vec2<f32>,
    @location(2) in_color: vec4<u8>,
};

struct VertexOutput {
    @builtin(position) out_pos: vec4<f32>,
    @location(0) out_uv: vec2<f32>,
    @location(1) out_color: vec4<f32>,
};

@vertex
fn main(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    output.out_pos = vec4<f32>(input.in_pos, 0.0, 1.0);
    output.out_uv = input.in_uv;
    // 将 u8 颜色归一化到 [0.0, 1.0]
    output.out_color = vec4<f32>(
        f32(input.in_color.r) / 255.0,
        f32(input.in_color.g) / 255.0,
        f32(input.in_color.b) / 255.0,
        f32(input.in_color.a) / 255.0,
    );
    return output;
}
"#;

/// 片段着色器 WGSL 源代码
///
/// 从 glyph atlas 纹理采样,混合前景色。
/// 如果纹理采样 alpha 为 0,则完全透明（不显示）。
///
/// 绑定:
/// - `@group(0) @binding(0)`:glyph atlas 纹理（sampler + texture）
pub const FRAGMENT_SHADER_SRC: &str = r#"
struct VertexOutput {
    @builtin(position) out_pos: vec4<f32>,
    @location(0) out_uv: vec2<f32>,
    @location(1) out_color: vec4<f32>,
};

@group(0) @binding(0) var glyph_sampler: sampler;
@group(0) @binding(1) var glyph_texture: texture_2d<f32>;

@fragment
fn main(input: VertexOutput) -> @location(0) vec4<f32> {
    // 从 glyph atlas 采样
    let sampled = textureSample(glyph_texture, glyph_sampler, input.out_uv);

    // 前景色 * 采样 alpha（字形边缘抗锯齿）
    return vec4<f32>(
        input.out_color.r * sampled.a + sampled.r * (1.0 - sampled.a),
        input.out_color.g * sampled.a + sampled.g * (1.0 - sampled.a),
        input.out_color.b * sampled.a + sampled.b * (1.0 - sampled.a),
        sampled.a,
    );
}
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_vertex_shader_src_not_empty() {
        assert!(!VERTEX_SHADER_SRC.is_empty());
        assert!(VERTEX_SHADER_SRC.contains("@vertex"));
        assert!(VERTEX_SHADER_SRC.contains("VertexInput"));
        assert!(VERTEX_SHADER_SRC.contains("VertexOutput"));
    }

    #[test]
    fn test_fragment_shader_src_not_empty() {
        assert!(!FRAGMENT_SHADER_SRC.is_empty());
        assert!(FRAGMENT_SHADER_SRC.contains("@fragment"));
        assert!(FRAGMENT_SHADER_SRC.contains("glyph_texture"));
        assert!(FRAGMENT_SHADER_SRC.contains("glyph_sampler"));
    }

    #[test]
    fn test_shader_layout_consistency() {
        // 顶点着色器输出 (out_uv, out_color) 应与片段着色器输入匹配
        assert!(VERTEX_SHADER_SRC.contains("@location(0) out_uv"));
        assert!(VERTEX_SHADER_SRC.contains("@location(1) out_color"));
        assert!(FRAGMENT_SHADER_SRC.contains("@location(0) out_uv"));
        assert!(FRAGMENT_SHADER_SRC.contains("@location(1) out_color"));
    }

    #[test]
    fn test_binding_layout() {
        // 片段着色器应绑定 sampler + texture
        assert!(FRAGMENT_SHADER_SRC.contains("@group(0) @binding(0)"));
        assert!(FRAGMENT_SHADER_SRC.contains("@group(0) @binding(1)"));
    }
}