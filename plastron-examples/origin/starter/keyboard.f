=cels("keyboard", 1, 6,
	geom(0.1, 0.26, 0.74, 0.46),
	at("a1", '=dom("button.pl-key",
			dom("style", "
				.pl-key {
					width: 150px;
					min-height: 150px;
					margin: 6px;
					border: 1px solid #9a9a9a;
					border-radius: 12px;
					display: flex;
					align-items: center;
					justify-content: center;
					font: 800 2rem ui-monospace, monospace;
					color: #222;
					background: linear-gradient(#fdfdfd, #d4d4d4);
					box-shadow: inset 0 1px 0 #fff, 0 5px 0 #aeaeae, 0 7px 10px #00000059;
					cursor: pointer;
					user-select: none;
					transition: background .06s, transform .06s, box-shadow .06s, color .06s;
				}
				.pl-key:hover {
					background: linear-gradient(#ffffff, #e8e8e8);
				}
				.pl-key:active {
					color: #fff;
					background: linear-gradient(#7db8ff, #2f86ff);
					transform: translateY(5px);
					box-shadow: inset 0 1px 0 #cfe4ff, 0 0 0 #aeaeae, 0 2px 4px #0000004d;
				}
			"),
			on("click", "origin.tone", 262),
			"C")'),
		at("b1", '=dom("button.pl-key",
			on("click", "origin.tone", 294),
			"D")'),
		at("c1", '=dom("button.pl-key",
			on("click", "origin.tone", 330),
			"E")'),
		at("d1", '=dom("button.pl-key",
			on("click", "origin.tone", 392),
			"G")'),
		at("e1", '=dom("button.pl-key",
			on("click", "origin.tone", 440),
			"A")'),
		at("f1", '=dom("button.pl-key",
			on("click", "origin.tone", 523),
			"C")'))
