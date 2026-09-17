//go:build windows

package main

import (
	"fmt"
	"os"
	"runtime"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

const (
	wmDestroy        = 0x0002
	wmClose          = 0x0010
	wmSetFont        = 0x0030
	wmCtlColorStatic = 0x0138
	wmUser           = 0x0400
	wsCaption        = 0x00c00000
	wsBorder         = 0x00800000
	wsChild          = 0x40000000
	wsVisible        = 0x10000000
	wsClipChildren   = 0x02000000
	wsExTopmost      = 0x00000008
	wsExToolWindow   = 0x00000080
	pbsMarquee       = 0x00000008
	pbmSetMarquee    = wmUser + 10
	swShow           = 5
	transparent      = 1
	fontWeightNormal = 400
	fontWeightBold   = 650
)

var (
	user32                  = syscall.NewLazyDLL("user32.dll")
	kernel32                = syscall.NewLazyDLL("kernel32.dll")
	gdi32                   = syscall.NewLazyDLL("gdi32.dll")
	comctl32                = syscall.NewLazyDLL("comctl32.dll")
	dwmapi                  = syscall.NewLazyDLL("dwmapi.dll")
	procRegisterClassExW    = user32.NewProc("RegisterClassExW")
	procCreateWindowExW     = user32.NewProc("CreateWindowExW")
	procDefWindowProcW      = user32.NewProc("DefWindowProcW")
	procDestroyWindow       = user32.NewProc("DestroyWindow")
	procPostQuitMessage     = user32.NewProc("PostQuitMessage")
	procGetMessageW         = user32.NewProc("GetMessageW")
	procTranslateMessage    = user32.NewProc("TranslateMessage")
	procDispatchMessageW    = user32.NewProc("DispatchMessageW")
	procShowWindow          = user32.NewProc("ShowWindow")
	procUpdateWindow        = user32.NewProc("UpdateWindow")
	procSetForegroundWindow = user32.NewProc("SetForegroundWindow")
	procSetWindowTextW      = user32.NewProc("SetWindowTextW")
	procSendMessageW        = user32.NewProc("SendMessageW")
	procPostMessageW        = user32.NewProc("PostMessageW")
	procGetSystemMetrics    = user32.NewProc("GetSystemMetrics")
	procSetTextColor        = gdi32.NewProc("SetTextColor")
	procSetBkMode           = gdi32.NewProc("SetBkMode")
	procCreateSolidBrush    = gdi32.NewProc("CreateSolidBrush")
	procCreateFontW         = gdi32.NewProc("CreateFontW")
	procDeleteObject        = gdi32.NewProc("DeleteObject")
	procGetModuleHandleW    = kernel32.NewProc("GetModuleHandleW")
	procInitCommonControls  = comctl32.NewProc("InitCommonControls")
	procDwmSetWindowAttr    = dwmapi.NewProc("DwmSetWindowAttribute")
	transitionBackground    uintptr
)

type winPoint struct {
	x int32
	y int32
}

type winMessage struct {
	hwnd    uintptr
	message uint32
	wParam  uintptr
	lParam  uintptr
	time    uint32
	point   winPoint
	private uint32
}

type winClassEx struct {
	size        uint32
	style       uint32
	wndProc     uintptr
	classExtra  int32
	windowExtra int32
	instance    uintptr
	icon        uintptr
	cursor      uintptr
	background  uintptr
	menuName    *uint16
	className   *uint16
	iconSmall   uintptr
}

type windowsTransition struct {
	mu     sync.Mutex
	hwnd   uintptr
	detail uintptr
	done   chan struct{}
}

func startUpdateTransition() updateTransition {
	window := &windowsTransition{done: make(chan struct{})}
	ready := make(chan bool, 1)
	go window.run(ready)
	select {
	case created := <-ready:
		if created {
			return window
		}
	case <-time.After(3 * time.Second):
	}
	return noopTransition{}
}

func (window *windowsTransition) SetDetail(value string) {
	window.mu.Lock()
	detail := window.detail
	window.mu.Unlock()
	if detail == 0 {
		return
	}
	text, err := syscall.UTF16PtrFromString(value)
	if err == nil {
		procSetWindowTextW.Call(detail, uintptr(unsafe.Pointer(text)))
	}
}

func (window *windowsTransition) Close() {
	window.mu.Lock()
	hwnd := window.hwnd
	window.mu.Unlock()
	if hwnd != 0 {
		procPostMessageW.Call(hwnd, wmClose, 0, 0)
	}
	select {
	case <-window.done:
	case <-time.After(2 * time.Second):
	}
}

func (window *windowsTransition) run(ready chan<- bool) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	defer close(window.done)

	procInitCommonControls.Call()
	instance, _, _ := procGetModuleHandleW.Call(0)
	className := utf16Pointer(fmt.Sprintf("DeepSeekUpdateTransition-%d", os.Getpid()))
	transitionBackground, _, _ = procCreateSolidBrush.Call(rgb(17, 23, 34))
	class := winClassEx{
		size:       uint32(unsafe.Sizeof(winClassEx{})),
		wndProc:    syscall.NewCallback(transitionWindowProc),
		instance:   instance,
		background: transitionBackground,
		className:  className,
	}
	registered, _, _ := procRegisterClassExW.Call(uintptr(unsafe.Pointer(&class)))
	if registered == 0 {
		ready <- false
		return
	}

	const width, height = 468, 216
	screenWidth, _, _ := procGetSystemMetrics.Call(0)
	screenHeight, _, _ := procGetSystemMetrics.Call(1)
	x := (int(screenWidth) - width) / 2
	y := (int(screenHeight) - height) / 2
	hwnd, _, _ := procCreateWindowExW.Call(
		wsExTopmost|wsExToolWindow,
		uintptr(unsafe.Pointer(className)),
		uintptr(unsafe.Pointer(utf16Pointer("DeepSeek Desktop 更新"))),
		wsCaption|wsBorder|wsClipChildren,
		uintptr(x), uintptr(y), width, height,
		0, 0, instance, 0,
	)
	if hwnd == 0 {
		ready <- false
		return
	}

	title := createTransitionChild(hwnd, "STATIC", "正在更新…", wsChild|wsVisible, 28, 25, 410, 34, instance)
	detail := createTransitionChild(hwnd, "STATIC", "正在准备更新，请稍候…", wsChild|wsVisible, 28, 70, 410, 28, instance)
	progress := createTransitionChild(hwnd, "msctls_progress32", "", wsChild|wsVisible|pbsMarquee, 28, 111, 410, 12, instance)
	hint := createTransitionChild(hwnd, "STATIC", "更新完成后，DeepSeek Desktop 会自动重新打开。", wsChild|wsVisible, 28, 139, 410, 25, instance)

	titleFont := createTransitionFont(-24, fontWeightBold)
	bodyFont := createTransitionFont(-15, fontWeightNormal)
	if titleFont != 0 {
		procSendMessageW.Call(title, wmSetFont, titleFont, 1)
		defer procDeleteObject.Call(titleFont)
	}
	if bodyFont != 0 {
		procSendMessageW.Call(detail, wmSetFont, bodyFont, 1)
		procSendMessageW.Call(hint, wmSetFont, bodyFont, 1)
		defer procDeleteObject.Call(bodyFont)
	}
	procSendMessageW.Call(progress, pbmSetMarquee, 1, 35)
	dark := int32(1)
	procDwmSetWindowAttr.Call(hwnd, 20, uintptr(unsafe.Pointer(&dark)), unsafe.Sizeof(dark))

	window.mu.Lock()
	window.hwnd = hwnd
	window.detail = detail
	window.mu.Unlock()
	// 0.2.13 launches the bootstrap with child_process.windowsHide=true. Windows may consume
	// the first ShowWindow call using that inherited SW_HIDE startup hint, so a second explicit
	// call is required for the very upgrade that introduces this transition window.
	procShowWindow.Call(hwnd, swShow)
	procShowWindow.Call(hwnd, swShow)
	procUpdateWindow.Call(hwnd)
	procSetForegroundWindow.Call(hwnd)
	ready <- true

	var message winMessage
	for {
		result, _, _ := procGetMessageW.Call(uintptr(unsafe.Pointer(&message)), 0, 0, 0)
		if result == 0 {
			break
		}
		procTranslateMessage.Call(uintptr(unsafe.Pointer(&message)))
		procDispatchMessageW.Call(uintptr(unsafe.Pointer(&message)))
	}
	window.mu.Lock()
	window.hwnd = 0
	window.detail = 0
	window.mu.Unlock()
}

func transitionWindowProc(hwnd uintptr, message uint32, wParam, lParam uintptr) uintptr {
	switch message {
	case wmClose:
		procDestroyWindow.Call(hwnd)
		return 0
	case wmDestroy:
		procPostQuitMessage.Call(0)
		return 0
	case wmCtlColorStatic:
		procSetTextColor.Call(wParam, rgb(231, 237, 247))
		procSetBkMode.Call(wParam, transparent)
		return transitionBackground
	default:
		result, _, _ := procDefWindowProcW.Call(hwnd, uintptr(message), wParam, lParam)
		return result
	}
}

func createTransitionChild(parent uintptr, className, value string, style uintptr, x, y, width, height int, instance uintptr) uintptr {
	hwnd, _, _ := procCreateWindowExW.Call(
		0,
		uintptr(unsafe.Pointer(utf16Pointer(className))),
		uintptr(unsafe.Pointer(utf16Pointer(value))),
		style,
		uintptr(x), uintptr(y), uintptr(width), uintptr(height),
		parent, 0, instance, 0,
	)
	return hwnd
}

func createTransitionFont(height, weight int) uintptr {
	font, _, _ := procCreateFontW.Call(
		uintptr(height), 0, 0, 0, uintptr(weight),
		0, 0, 0, 1, 0, 0, 5, 0,
		uintptr(unsafe.Pointer(utf16Pointer("Segoe UI"))),
	)
	return font
}

func utf16Pointer(value string) *uint16 {
	pointer, _ := syscall.UTF16PtrFromString(value)
	return pointer
}

func rgb(red, green, blue uintptr) uintptr {
	return red | green<<8 | blue<<16
}
