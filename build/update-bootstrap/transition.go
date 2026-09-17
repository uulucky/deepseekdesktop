package main

// updateTransition keeps a small native status window alive while Electron is not running.
// Platform-specific implementations deliberately expose only text updates and close: the
// update work and its durable log remain authoritative even if the window cannot be created.
type updateTransition interface {
	SetDetail(string)
	Close()
}

type noopTransition struct{}

func (noopTransition) SetDetail(string) {}
func (noopTransition) Close()           {}
