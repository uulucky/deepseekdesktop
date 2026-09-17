//go:build !windows

package main

func startUpdateTransition() updateTransition { return noopTransition{} }
