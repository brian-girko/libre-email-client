#[test]
fn parse_stub_fetch() {
    let line = b"* 1 FETCH (UID 101 FLAGS (\\Seen) ENVELOPE (\"Mon, 7 Sep 2026 09:00:00 +0000\" \"Hello from the stub\" (\"Alice Example\" NIL \"alice\" \"example.com\") NIL NIL (\"Alice Example\" NIL \"alice\" \"example.com\") NIL NIL NIL NIL))\r\n";
    match imap_proto::parser::parse_response(line) {
        Ok((rest, resp)) => println!("OK rest={rest:?}\n{resp:?}"),
        Err(e) => println!("ERR {e:?}"),
    }
}

#[test]
fn parse_body_section() {
    let mut line: Vec<u8> = b"* 1 FETCH (UID 101 BODY[] {11}".to_vec();
    line.extend_from_slice(b"\r\n");
    line.extend_from_slice(b"hello world)");
    line.extend_from_slice(b"\r\n");
    match imap_proto::parser::parse_response(&line) {
        Ok((rest, resp)) => println!("OK rest={rest:?}\n{resp:?}"),
        Err(e) => println!("ERR {e:?}"),
    }
    let line2 = b"* 1 FETCH (UID 101 BODY[] {11}\r\nhello world)\r\n";
    match imap_proto::parser::parse_response(line2) {
        Ok((rest, resp)) => println!("OK2 rest={rest:?}\n{resp:?}"),
        Err(e) => println!("ERR2 {e:?}"),
    }
}

#[test]
fn parse_address_variants() {
    let lines: [&[u8]; 4] = [
        b"* 1 FETCH (ENVELOPE (NIL \"subj\" ((\"Alice\" NIL \"alice\" \"example.com\")) NIL NIL NIL NIL NIL NIL NIL NIL))\r\n",
        b"* 1 FETCH (ENVELOPE (NIL \"subj\" ((NIL NIL \"alice\" \"example.com\")) NIL NIL NIL NIL NIL NIL NIL NIL))\r\n",
        b"* 1 FETCH (ENVELOPE (NIL \"subj\" ((\"Alice Example\" NIL \"alice\" \"example.com\")) NIL NIL NIL NIL NIL NIL NIL NIL))\r\n",
        b"* 1 FETCH (ENVELOPE (NIL \"subj\" ((\"Alice Example\" \"NIL\" \"alice\" \"example.com\")) NIL NIL NIL NIL NIL NIL NIL NIL))\r\n",
    ];
    for (i, line) in lines.iter().enumerate() {
        match imap_proto::parser::parse_response(line) {
            Ok((rest, resp)) => println!("[{i}] OK rest={rest:?}\n{resp:?}"),
            Err(e) => println!("[{i}] ERR {e:?}"),
        }
    }
}

#[test]
fn parse_fetch_variants() {
    let lines: [&[u8]; 6] = [
        b"* 1 FETCH (UID 101 FLAGS (\\Seen))\r\n",
        b"* 1 FETCH (UID 101 FLAGS (\\Seen) ENVELOPE (NIL \"subj\" NIL NIL NIL NIL NIL NIL NIL NIL))\r\n",
        b"* 1 FETCH (UID 101 FLAGS (\\Seen) ENVELOPE (\"Mon\" \"subj\" NIL NIL NIL NIL NIL NIL NIL NIL))\r\n",
        b"* 1 FETCH (UID 101 FLAGS (\\Seen) ENVELOPE (\"Mon, 7\" \"subj\" NIL NIL NIL NIL NIL NIL NIL NIL))\r\n",
        b"* 1 FETCH (UID 101 FLAGS (\\Seen) ENVELOPE (\"Mon, 7 Sep 2026 09:00:00 +0000\" \"subj\" NIL NIL NIL NIL NIL NIL NIL NIL))\r\n",
        b"* 1 FETCH (UID 101 FLAGS (\\Seen) ENVELOPE (NIL \"subj\" (\"Alice Example\" NIL \"alice\" \"example.com\") NIL NIL NIL NIL NIL NIL NIL))\r\n",
    ];
    for (i, line) in lines.iter().enumerate() {
        match imap_proto::parser::parse_response(line) {
            Ok((rest, resp)) => println!("[{i}] OK rest={rest:?}\n{resp:?}"),
            Err(e) => println!("[{i}] ERR {e:?}"),
        }
    }
}

#[test]
fn parse_stub_body() {
    let body = "From: Alice Example <alice@example.com>\r\nTo: user@example.com\r\nSubject: Hello from the stub\r\nDate: Mon, 7 Sep 2026 09:00:00 +0000\r\nMessage-ID: <stub-101@example.com>\r\n\r\nThis is stub message #1.\r\n";
    let mut line: Vec<u8> = b"* 1 FETCH (UID 101 BODY[] {".to_vec();
    line.extend_from_slice(body.len().to_string().as_bytes());
    line.extend_from_slice(b"}\r\n");
    line.extend_from_slice(body.as_bytes());
    line.extend_from_slice(b")\r\n");
    match imap_proto::parser::parse_response(&line) {
        Ok((rest, resp)) => println!("OK rest={rest:?}\n{resp:?}"),
        Err(e) => println!("ERR {e:?}"),
    }
}

#[test]
fn parse_header_block_unfolds_and_lowercases() {
    let block = b"Message-ID: <a@x>\r\nIn-Reply-To: <b@x>\r\nReferences: <a@x>\r\n <b@x>\r\n\t<c@x>\r\nSubject: hi\r\n\r\nbody";
    let headers = mail_core::parse_headers(block);
    assert_eq!(mail_core::header_value(&headers, "message-id"), Some("<a@x>"));
    assert_eq!(mail_core::header_value(&headers, "in-reply-to"), Some("<b@x>"));
    assert_eq!(
        mail_core::header_value(&headers, "references"),
        Some("<a@x> <b@x> <c@x>")
    );
    assert_eq!(mail_core::header_value(&headers, "MESSAGE-ID"), Some("<a@x>"));
    assert_eq!(mail_core::header_value(&headers, "missing"), None);
}
