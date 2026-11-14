use smallvec::SmallVec;

pub mod messy;

pub fn add(a: i32, b: i32) -> i32 {
    a + b
}

pub fn first_two(v: &[i32]) -> SmallVec<[i32; 2]> {
    v.iter().take(2).copied().collect()
}

pub fn has_none(v: &[i32]) -> bool {
    v.len() == 0
}
