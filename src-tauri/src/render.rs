use crate::mesh::Facet;
use image::{Rgb, RgbImage};

type Vec3 = [f32; 3];

const SUPERSAMPLE: usize = 2;
const FIT: f32 = 0.86;

fn dot(a: Vec3, b: Vec3) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn cross(a: Vec3, b: Vec3) -> Vec3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn unit(a: Vec3) -> Option<Vec3> {
    let length = dot(a, a).sqrt();
    if length < 1e-9 || !length.is_finite() {
        return None;
    }
    Some([a[0] / length, a[1] / length, a[2] / length])
}

fn mix(a: Vec3, b: Vec3, t: f32) -> Vec3 {
    [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
    ]
}

struct Projected {
    x: f32,
    y: f32,
    z: f32,
}

pub fn render(facets: &[Facet], size: u32) -> Option<RgbImage> {
    let side = (size.clamp(32, 1024) as usize) * SUPERSAMPLE;
    if facets.is_empty() {
        return None;
    }

    let mut low = [f32::MAX; 3];
    let mut high = [f32::MIN; 3];
    let mut points = 0usize;
    for facet in facets {
        for point in facet.points {
            if !point.iter().all(|v| v.is_finite()) {
                continue;
            }
            for axis in 0..3 {
                low[axis] = low[axis].min(point[axis]);
                high[axis] = high[axis].max(point[axis]);
            }
            points += 1;
        }
    }
    if points < 3 {
        return None;
    }
    let center = mix(low, high, 0.5);

    // A diagonal eye direction keeps Y-up and Z-up models readable without guessing their axis convention.
    let forward = unit([-1.0, -1.0, -1.0])?;
    let right = unit(cross(forward, [0.0, 0.0, 1.0]))?;
    let up = cross(right, forward);
    let key = unit(add(right, add(scale(up, 1.1), scale(forward, -1.4))))?;
    let fill = unit(sub(
        scale(right, 1.2),
        add(scale(up, 0.3), scale(forward, 1.0)),
    ))?;

    let project = |point: Vec3| -> Projected {
        let rel = sub(point, center);
        Projected {
            x: dot(rel, right),
            y: dot(rel, up),
            z: dot(rel, forward),
        }
    };

    let mut x_low = f32::MAX;
    let mut x_high = f32::MIN;
    let mut y_low = f32::MAX;
    let mut y_high = f32::MIN;
    let mut z_low = f32::MAX;
    let mut z_high = f32::MIN;
    for facet in facets {
        for point in facet.points {
            let p = project(point);
            x_low = x_low.min(p.x);
            x_high = x_high.max(p.x);
            y_low = y_low.min(p.y);
            y_high = y_high.max(p.y);
            z_low = z_low.min(p.z);
            z_high = z_high.max(p.z);
        }
    }
    let mid_x = (x_low + x_high) * 0.5;
    let mid_y = (y_low + y_high) * 0.5;
    let radius = ((x_high - x_low).max(y_high - y_low) * 0.5).max(1e-3);
    let scale_px = FIT * (side as f32 * 0.5) / radius;
    let depth_span = (z_high - z_low).max(1e-6);

    let background = |row: usize| -> Vec3 {
        let t = row as f32 / side as f32;
        mix([38.0, 44.0, 58.0], [15.0, 17.0, 24.0], t)
    };

    let pixels = side * side;
    let mut color: Vec<u8> = Vec::with_capacity(pixels * 3);
    color.resize(pixels * 3, 0);
    for row in 0..side {
        let tone = background(row);
        for _ in 0..side {
            color.push(tone[0] as u8);
            color.push(tone[1] as u8);
            color.push(tone[2] as u8);
        }
    }
    let mut depth: Vec<f32> = vec![f32::MAX; pixels];

    for facet in facets {
        let normal = match unit(cross(
            sub(facet.points[1], facet.points[0]),
            sub(facet.points[2], facet.points[0]),
        )) {
            Some(normal) => normal,
            None => continue,
        };
        let facing = dot(normal, forward);
        let lit = if facing > 0.0 {
            [-normal[0], -normal[1], -normal[2]]
        } else {
            normal
        };
        let diffuse = 0.20 + 0.66 * dot(lit, key).max(0.0) + 0.24 * dot(lit, fill).max(0.0);
        let tone = [
            (236.0 * diffuse).min(255.0),
            (240.0 * diffuse).min(255.0),
            (248.0 * diffuse).min(255.0),
        ];

        let corners: [Projected; 3] = facet.points.each_ref().map(|point| {
            let p = project(*point);
            Projected {
                x: (p.x - mid_x) * scale_px + side as f32 * 0.5,
                y: -(p.y - mid_y) * scale_px + side as f32 * 0.5,
                z: p.z,
            }
        });

        let min_x = corners[0]
            .x
            .min(corners[1].x)
            .min(corners[2].x)
            .max(0.0)
            .floor() as isize;
        let max_x = corners[0]
            .x
            .max(corners[1].x)
            .max(corners[2].x)
            .min(side as f32 - 1.0)
            .ceil() as isize;
        let min_y = corners[0]
            .y
            .min(corners[1].y)
            .min(corners[2].y)
            .max(0.0)
            .floor() as isize;
        let max_y = corners[0]
            .y
            .max(corners[1].y)
            .max(corners[2].y)
            .min(side as f32 - 1.0)
            .ceil() as isize;
        if min_x > max_x || min_y > max_y {
            continue;
        }

        let area = edge(&corners[0], &corners[1], corners[2].x, corners[2].y);
        if area.abs() < 1e-6 {
            continue;
        }
        let sign = if area > 0.0 { 1.0 } else { -1.0 };
        let dzdx = ((corners[1].z - corners[0].z) * (corners[2].y - corners[0].y)
            - (corners[2].z - corners[0].z) * (corners[1].y - corners[0].y))
            / area;
        let dzdy = ((corners[2].z - corners[0].z) * (corners[1].x - corners[0].x)
            - (corners[1].z - corners[0].z) * (corners[2].x - corners[0].x))
            / area;

        for y in min_y..=max_y {
            for x in min_x..=max_x {
                let px = x as f32 + 0.5;
                let py = y as f32 + 0.5;
                let w0 = edge(&corners[1], &corners[2], px, py) * sign;
                if w0 < 0.0 {
                    continue;
                }
                let w1 = edge(&corners[2], &corners[0], px, py) * sign;
                if w1 < 0.0 {
                    continue;
                }
                let w2 = edge(&corners[0], &corners[1], px, py) * sign;
                if w2 < 0.0 {
                    continue;
                }
                let z = corners[0].z + dzdx * (px - corners[0].x) + dzdy * (py - corners[0].y);
                let offset = (y as usize * side + x as usize) * 3;
                if z >= depth[offset / 3] {
                    continue;
                }
                depth[offset / 3] = z;
                let fade = 1.0 - 0.30 * ((z - z_low) / depth_span).clamp(0.0, 1.0);
                for channel in 0..3 {
                    color[offset + channel] = (tone[channel] * fade) as u8;
                }
            }
        }
    }

    if depth.iter().all(|z| *z == f32::MAX) {
        return None;
    }

    let out = side / SUPERSAMPLE;
    let mut image = RgbImage::new(out as u32, out as u32);
    for (y, row) in image.rows_mut().enumerate() {
        for (x, pixel) in row.enumerate() {
            let mut sum = [0u32; 3];
            for dy in 0..SUPERSAMPLE {
                for dx in 0..SUPERSAMPLE {
                    let sy = (y * SUPERSAMPLE + dy).min(side - 1);
                    let sx = (x * SUPERSAMPLE + dx).min(side - 1);
                    let offset = (sy * side + sx) * 3;
                    for channel in 0..3 {
                        sum[channel] += color[offset + channel] as u32;
                    }
                }
            }
            let weight = (SUPERSAMPLE * SUPERSAMPLE) as u32;
            *pixel = Rgb([
                (sum[0] / weight) as u8,
                (sum[1] / weight) as u8,
                (sum[2] / weight) as u8,
            ]);
        }
    }
    Some(image)
}

fn edge(a: &Projected, b: &Projected, px: f32, py: f32) -> f32 {
    (b.x - a.x) * (py - a.y) - (b.y - a.y) * (px - a.x)
}

fn add(a: Vec3, b: Vec3) -> Vec3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

fn sub(a: Vec3, b: Vec3) -> Vec3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn scale(a: Vec3, k: f32) -> Vec3 {
    [a[0] * k, a[1] * k, a[2] * k]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cube() -> Vec<Facet> {
        let corners: [Vec3; 8] = [
            [-1.0, -1.0, -1.0],
            [1.0, -1.0, -1.0],
            [1.0, 1.0, -1.0],
            [-1.0, 1.0, -1.0],
            [-1.0, -1.0, 1.0],
            [1.0, -1.0, 1.0],
            [1.0, 1.0, 1.0],
            [-1.0, 1.0, 1.0],
        ];
        let faces = [
            [0, 1, 2, 3],
            [4, 5, 6, 7],
            [0, 1, 5, 4],
            [2, 3, 7, 6],
            [1, 2, 6, 5],
            [0, 3, 7, 4],
        ];
        let mut facets = Vec::new();
        for face in faces {
            facets.push(Facet {
                points: [corners[face[0]], corners[face[1]], corners[face[2]]],
            });
            facets.push(Facet {
                points: [corners[face[0]], corners[face[2]], corners[face[3]]],
            });
        }
        facets
    }

    #[test]
    fn renders_a_cube_with_shaded_faces() {
        let image = render(&cube(), 64).expect("cube should render");
        assert_eq!((image.width(), image.height()), (64, 64));
        let mut shaded = 0usize;
        for pixel in image.pixels() {
            if pixel[0] > 90 && pixel[2] > 90 {
                shaded += 1;
            }
        }
        assert!(shaded > 64 * 64 / 4, "shaded pixels: {shaded}");
    }

    #[test]
    fn rejects_empty_meshes() {
        assert!(render(&[], 64).is_none());
    }
}
