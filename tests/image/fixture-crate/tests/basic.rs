#[test]
fn adds() {
    assert_eq!(fixture::add(1, 2), 3);
    assert_eq!(fixture::first_two(&[1, 2, 3]).len(), 2);
    assert!(!fixture::has_none(&[1]));
    assert_eq!(fixture::messy::double(2), 4);
}

#[test]
fn fails_on_purpose() {
    assert_eq!(fixture::add(2, 2), 5);
}
