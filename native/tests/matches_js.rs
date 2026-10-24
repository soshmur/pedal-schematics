//! The Rust engine must sound the same as the browser's. For each pedal this runs
//! the netlist and test signal from `fixtures/<pedal>.json` (written by
//! `node tests/make_fixtures.mjs`) and compares against the JS engine's output.
use pedal_engine::engine::{Circuit, Netlist};
use serde::Deserialize;
use std::path::Path;

#[derive(Deserialize)]
struct Fixture {
    fs: f64,
    net: Netlist,
    net2: Netlist,
    input: Vec<f64>,
    dc: Vec<f64>,
    #[serde(rename = "dcConverged")]
    dc_converged: bool,
    out: Vec<f64>,
    out2: Vec<f64>,
}

const PEDALS: [&str; 8] = ["booster", "fuzz", "electra", "ocd", "screamer", "rodent", "echo", "chorus"];

fn rms(v: &[f64]) -> f64 { (v.iter().map(|x| x * x).sum::<f64>() / v.len() as f64).sqrt() }

#[test]
fn every_pedal_matches_the_js_engine() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    if !dir.join("booster.json").exists() {
        panic!("fixtures missing: run `node native/tests/make_fixtures.mjs` from the repo root first");
    }
    let mut failures = vec![];
    for key in PEDALS {
        let f: Fixture = serde_json::from_str(&std::fs::read_to_string(dir.join(format!("{key}.json"))).unwrap()).unwrap();
        let mut c = Circuit::new(&f.net, f.fs).unwrap();
        assert_eq!(c.dc_converged, f.dc_converged, "{key}: DC convergence differs");
        let dc_err = c.x.iter().zip(&f.dc).map(|(a, b)| (a - b).abs()).fold(0.0, f64::max);

        let t = std::time::Instant::now();
        let out: Vec<f64> = f.input.iter().map(|&v| c.step(v)).collect();
        let secs = t.elapsed().as_secs_f64();
        c.update(&f.net2).unwrap();
        let out2: Vec<f64> = f.input[..f.out2.len()].iter().map(|&v| c.step(v)).collect();

        // compare the AC part (outputs sit on a DC bias)
        let mean = |v: &[f64]| v.iter().sum::<f64>() / v.len() as f64;
        let (mo, mj) = (mean(&out), mean(&f.out));
        let diff: Vec<f64> = out.iter().zip(&f.out).map(|(a, b)| (a - mo) - (b - mj)).collect();
        let sig = rms(&f.out.iter().map(|b| b - mj).collect::<Vec<_>>());
        let rel = rms(&diff) / sig.max(1e-9);
        let diff2: Vec<f64> = out2.iter().zip(&f.out2).map(|(a, b)| a - b).collect();
        let rel2 = rms(&diff2) / sig.max(1e-9);
        let realtime = secs / (f.input.len() as f64 / f.fs);
        println!("{key:9} dc err {dc_err:.2e}  out err {:.4}%  after knob change {:.4}%  {:.1}% of real time ({} failures)",
            rel * 100.0, rel2 * 100.0, realtime * 100.0, c.stats.failures);
        if dc_err > 1e-6 || rel > 1e-3 || rel2 > 1e-3 { failures.push(key); }
    }
    assert!(failures.is_empty(), "differs from the JS engine: {failures:?}");
}
