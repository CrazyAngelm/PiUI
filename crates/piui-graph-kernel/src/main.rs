use std::{io, process::ExitCode};

fn main() -> ExitCode {
    if std::env::args_os().nth(1).is_some() {
        eprintln!("The graph kernel accepts requests only over its private stdin pipe.");
        return ExitCode::FAILURE;
    }
    let input = io::stdin();
    let output = io::stdout();
    match piui_graph_kernel::serve(&mut input.lock(), &mut output.lock()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(_) => {
            eprintln!("The graph kernel pipe could not be read or written.");
            ExitCode::FAILURE
        }
    }
}
