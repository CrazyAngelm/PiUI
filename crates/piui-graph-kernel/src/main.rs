use std::{io, process::ExitCode};

fn main() -> ExitCode {
    // Without an argument the kernel speaks protocol 1 exactly as before; a
    // host that also speaks protocol 2 asks for it at launch.
    let mut arguments = std::env::args_os().skip(1);
    let with_protocol_2 = match (arguments.next(), arguments.next()) {
        (None, _) => false,
        (Some(flag), None) if flag == "--with-protocol-2" => true,
        _ => {
            eprintln!("The graph kernel accepts requests only over its private stdin pipe.");
            return ExitCode::FAILURE;
        }
    };
    let input = io::stdin();
    let output = io::stdout();
    let served = if with_protocol_2 {
        piui_graph_kernel::serve_with_protocol_2(&mut input.lock(), &mut output.lock())
    } else {
        piui_graph_kernel::serve(&mut input.lock(), &mut output.lock())
    };
    match served {
        Ok(()) => ExitCode::SUCCESS,
        Err(_) => {
            eprintln!("The graph kernel pipe could not be read or written.");
            ExitCode::FAILURE
        }
    }
}
