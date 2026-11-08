package main

// 扫描器注册表（对应 src/main/scanner/registry.ts），顺序与 Electron 侧一致。
func allScanners() []Scanner {
	scanners := []Scanner{
		zcodeScanner{},
		traeScanner{},
		qoderScanner{},
		codebuddyScanner{},
		workbuddyScanner{},
		dshScanner{id: "dsh-web", name: "DSH Web", home: ".dsh", color: "#8b5cf6"},
		dshScanner{id: "dsh-desktop", name: "DSH Desktop", home: ".dsh-desktop", color: "#a78bfa", appTag: dshDesktopApp},
	}
	scanners = append(scanners, opencodeScanners()...)
	scanners = append(scanners,
		agnesScanner{},
		ycliScanner{},
		hubScanner{},
	)
	return append(scanners, genericScanners()...)
}
